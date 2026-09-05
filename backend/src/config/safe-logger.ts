import type { LoggerService, LogLevel } from '@nestjs/common';
import type { Logger, LogEntry } from 'winston';
import { types } from 'node:util';
import { writeSync } from 'node:fs';
import { currentCorrelation } from '../observability/correlation-context';
import { HTTP_METHODS, HTTP_ROUTE_GROUPS, JOB_OUTCOMES, STRUCTURED_EVENT_CODES } from '../observability/structured-event';
import { QUEUE_NAMES } from '../jobs/queue-policy';
import { redactLogMetadata, redactSecretText } from './secret-redaction';

export type LogRole = 'api' | 'worker';
export const SAFE_LOG_LIMITS = Object.freeze({ messageBytes: 8192, recordBytes: 16 * 1024 });
const LEVEL = Symbol.for('level');
const levels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const;
type Level = typeof levels[number];
type SafeLogEntry = LogEntry & Record<string | symbol, unknown>;
const eventCodes = new Set<string>([...STRUCTURED_EVENT_CODES, 'LOG_EVENT', 'LOG_ERROR', 'LOG_REDACTED',
  'API_START_FAILED', 'WORKER_START_FAILED', 'WORKER_STARTED', 'WORKER_SHUTDOWN_FAILED',
  'OUTBOX_CONSUMER_FAILED', 'OUTBOX_ADAPTER_FAILED', 'OUTBOX_REDIS_UNAVAILABLE', 'OUTBOX_POLL_FAILED',
  'OUTBOX_TRANSPORT_FAILED', 'OUTBOX_INVALID_PAYLOAD', 'RENDER_DISPATCH_FAILED',
  'RENDER_FAILED', 'RENDER_PIXELS_FAILED', 'RENDER_VALIDATION_FAILED', 'RENDER_STORAGE_FAILED', 'RENDER_STALE_CLAIM',
  'SOURCE_TIMEOUT', 'SOURCE_REFRESH_FAILED', 'SOURCE_SNAPSHOT_UNAVAILABLE', 'SOURCE_REFRESH_REQUIRES_CONNECTOR',
  'SOURCE_SECRET_UNAVAILABLE', 'SOURCE_TRANSFORM_FAILED', 'SOURCE_ABORTED', 'REMOTE_SYNC_FAILED']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const identifier = /^[a-zA-Z0-9-]{1,100}$/;
const textCode = /(?<![a-z0-9_-])((?:"code"|'code'|code)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;{}]+)/gi;

export function isLogEventCode(value: unknown): value is string {
  return typeof value === 'string' && eventCodes.has(value);
}

export function redactLogText(value: string): string {
  if (value.length > SAFE_LOG_LIMITS.messageBytes || Buffer.byteLength(value) > SAFE_LOG_LIMITS.messageBytes) return '[REDACTED]';
  return redactSecretText(value).replace(textCode, '$1[REDACTED]')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{5}[- ][0-9A-HJKMNP-TV-Z]{5}\b/gi, '[REDACTED]')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{10}\b/gi, '[REDACTED]')
    .replace(/\b((?:pairing|enrollment|one[- ]time|short)[ _-]+code)\s*[:=]?\s+\S+/gi, '$1 [REDACTED]');
}

/** No untrusted object reaches Nest-Winston, Winston's overloads or formatters. */
export function safeLogRecord(
  input: unknown,
  role: LogRole = 'api',
  forcedLevel?: Level,
  context?: unknown,
): SafeLogEntry {
  let rawCode: unknown;
  let nativeError = false;
  if (input && typeof input === 'object' && !types.isProxy(input)) {
    nativeError = types.isNativeError(input);
    if (!nativeError) {
      const descriptor = Object.getOwnPropertyDescriptor(input, 'code');
      if (descriptor && 'value' in descriptor) rawCode = descriptor.value;
    }
  }
  // Error text is neither a domain contract nor safe metadata. Do not inspect it.
  const projected = nativeError ? undefined : redactLogMetadata(input);
  const safe = projected && typeof projected === 'object' && !Array.isArray(projected)
    ? projected as Record<string, unknown> : {};
  const selected = forcedLevel ?? (typeof safe.level === 'string' && (levels as readonly string[]).includes(safe.level) ? safe.level as Level : 'info');
  const code = nativeError ? 'LOG_ERROR' : isLogEventCode(rawCode) ? rawCode : rawCode === undefined ? 'LOG_EVENT' : 'LOG_REDACTED';
  const result: SafeLogEntry = {
    protocolVersion: '1.0', timestamp: new Date().toISOString(), level: selected, role, code,
    message: nativeError ? 'LOG_ERROR' : code === 'LOG_REDACTED' ? '[REDACTED]' : typeof projected === 'string' ? redactLogText(projected)
      : typeof safe.message === 'string' ? redactLogText(safe.message) : code,
    ...currentCorrelation(),
  };
  for (const key of ['correlationId', 'sourceDefinitionId', 'subscriptionId'] as const) {
    if (typeof safe[key] === 'string' && uuid.test(safe[key])) result[key] = safe[key];
  }
  for (const key of ['eventId', 'deliveryId'] as const) {
    if (typeof safe[key] === 'string' && identifier.test(safe[key])) result[key] = safe[key];
  }
  const enums = { role: ['api', 'worker'], queue: QUEUE_NAMES, route: HTTP_ROUTE_GROUPS, method: HTTP_METHODS, outcome: JOB_OUTCOMES };
  for (const key of ['role', 'queue', 'route', 'method', 'outcome'] as const) {
    if ((enums[key] as readonly unknown[]).includes(safe[key])) result[key] = safe[key];
  }
  for (const [key, min, max] of [['deviceId', 1, Number.MAX_SAFE_INTEGER], ['attempt', 0, 5], ['statusCode', 100, 599]] as const) {
    if (typeof safe[key] === 'number' && Number.isSafeInteger(safe[key]) && safe[key] >= min && safe[key] <= max) result[key] = safe[key];
  }
  if (typeof safe.durationMs === 'number' && Number.isFinite(safe.durationMs) && safe.durationMs >= 0 && safe.durationMs <= 86_400_000) result.durationMs = safe.durationMs;
  const component = context ?? safe.context;
  if (typeof component === 'string' && component.length <= 100
    && /^[A-Za-z][A-Za-z0-9]*(?:Service|Controller|Module|Gateway|Guard|Filter|Interceptor|Processor|Resolver|Adapter|Registry|Dispatcher|Coordinator|Factory|Application|Explorer|Loader)$/.test(component)
    && redactSecretText(component) === component) result.context = component;
  result[LEVEL] = selected;
  if (Buffer.byteLength(JSON.stringify(result)) > SAFE_LOG_LIMITS.recordBytes) {
    return { protocolVersion: '1.0', timestamp: new Date().toISOString(), level: selected, role,
      code: 'LOG_REDACTED', message: '[REDACTED]', [LEVEL]: selected, ...currentCorrelation() };
  }
  return result;
}

export class SafeLogger implements LoggerService {
  constructor(private readonly sink: Logger, private readonly role: LogRole = 'api') {}

  private write(level: Level | undefined, input: unknown, parameters: unknown[]) {
    // Nest appends its component context. Stack arguments and arbitrary splats
    // are deliberately not interpolated or forwarded to any formatter.
    const context = parameters.length <= 4 && (level !== 'error' || parameters.length >= 2)
      ? parameters[parameters.length - 1] : undefined;
    try { this.sink.log(safeLogRecord(input, this.role, level, context)); }
    catch { /* Logging cannot break an HTTP response or a fenced job. */ }
  }
  log(message: unknown, ...parameters: unknown[]): void { this.write(undefined, message, parameters); }
  error(message: unknown, ...parameters: unknown[]): void { this.write('error', message, parameters); }
  warn(message: unknown, ...parameters: unknown[]): void { this.write('warn', message, parameters); }
  debug(message: unknown, ...parameters: unknown[]): void { this.write('debug', message, parameters); }
  verbose(message: unknown, ...parameters: unknown[]): void { this.write('verbose', message, parameters); }
  fatal(message: unknown, ...parameters: unknown[]): void { this.write('error', message, parameters); }
  setLogLevels(value: LogLevel[]): void {
    if (types.isProxy(value) || !Array.isArray(value) || value.length > 6) return;
    const requested: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item || !('value' in item) || !['log', 'error', 'warn', 'debug', 'verbose', 'fatal'].includes(item.value)) return;
      requested.push(item.value === 'log' ? 'info' : item.value === 'fatal' ? 'error' : item.value);
    }
    this.sink.silent = requested.length === 0;
    this.sink.level = [...levels].reverse().find(item => requested.includes(item)) ?? 'info';
  }
}

/** Synchronous bounded startup fallback: never touch error.message/stack/toString. */
export function logStartupFailure(role: LogRole, _error: unknown): void {
  const safeRole = role === 'worker' ? 'worker' : 'api';
  const record = { protocolVersion: '1.0', timestamp: new Date().toISOString(), level: 'error', role: safeRole,
    code: safeRole === 'worker' ? 'WORKER_START_FAILED' : 'API_START_FAILED' };
  try { writeSync(2, `${JSON.stringify(record)}\n`); } catch { /* No raw error fallback. */ }
}
