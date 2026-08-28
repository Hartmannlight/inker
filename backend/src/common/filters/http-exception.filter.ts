import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger, type LoggerService } from '@nestjs/common';
import type { Request, Response } from 'express';
import { types } from 'node:util';
import { randomUUID } from 'node:crypto';
import { redactLogValue } from '../../config/secret-redaction';
import { isLogEventCode, redactLogText } from '../../config/safe-logger';
import { currentCorrelation } from '../../observability/correlation-context';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Read data descriptors only; never call overridden exception methods. */
function property(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function httpException(value: unknown): { status: number; response: unknown } | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !types.isNativeError(value)) return;
  let prototype = Object.getPrototypeOf(value);
  for (let depth = 0; prototype && depth < 12; depth++) {
    if (types.isProxy(prototype)) return;
    if (prototype === HttpException.prototype) {
      const status = property(value, 'status');
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
        return { status, response: property(value, 'response') };
      }
      return;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
}

function publicBody(value: unknown, fallback: string): Record<string, unknown> {
  const safe = redactLogValue(value);
  const text = (item: unknown, max = 2048): item is string => typeof item === 'string' && item.length <= max && Buffer.byteLength(item) <= max;
  if (text(safe)) return { message: redactLogText(safe) };
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) return { message: fallback };
  const record = safe as Record<string, unknown>;
  const result: Record<string, unknown> = { message: fallback };
  if (text(record.message)) result.message = redactLogText(record.message);
  else if (Array.isArray(record.message) && record.message.length <= 32 && record.message.every(item => text(item, 512))) result.message = record.message.map(redactLogText);
  // Retain Nest validation and TRMNL problem details, not arbitrary payloads.
  for (const key of ['error', 'type', 'status', 'detail', 'instance']) if (text(record[key])) result[key] = redactLogText(record[key]);
  if (record.code !== undefined) result.code = isLogEventCode(record.code) ? record.code : '[REDACTED]';
  const extensions = record.extensions;
  if (extensions && typeof extensions === 'object' && !Array.isArray(extensions)) {
    const errors = (extensions as Record<string, unknown>).errors;
    if (errors && typeof errors === 'object' && !Array.isArray(errors) && Object.keys(errors).length <= 16) {
      const projected: Record<string, unknown> = {};
      for (const [key, messages] of Object.entries(errors)) {
        if (/^[a-zA-Z0-9_-]{1,64}$/.test(key) && (text(messages, 512)
          || (Array.isArray(messages) && messages.length <= 16 && messages.every(item => text(item, 512))))) {
          projected[key] = typeof messages === 'string' ? redactLogText(messages) : (messages as string[]).map(redactLogText);
        }
      }
      result.extensions = { errors: projected };
    }
  }
  return Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024 ? result : { message: fallback };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Pick<LoggerService, 'error' | 'warn'> = new Logger(HttpExceptionFilter.name)) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    let known: ReturnType<typeof httpException>;
    try { known = httpException(exception); } catch { /* Constant fallback below. */ }
    const status = known?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const fallback = status >= 500 ? 'Internal server error' : 'Request failed';
    let body: Record<string, unknown> = { message: fallback };
    try { if (known) body = publicBody(known.response, fallback); } catch { /* Never inspect the thrown value. */ }
    const rawMethod = property(request, 'method');
    const method = typeof rawMethod === 'string' && METHODS.has(rawMethod) ? rawMethod : 'OTHER';
    const route = property(property(request, 'route'), 'path');
    // Templates contain no submitted parameter, query, credential or code.
    const path = typeof route === 'string' && /^\/[a-zA-Z0-9/_:.*-]{0,199}$/.test(route) ? route : '/[unmatched]';
    const correlationId = currentCorrelation()?.correlationId ?? randomUUID();
    const result = { ...body, statusCode: status, timestamp: new Date().toISOString(), path, method, correlationId };
    try {
      const event = { code: 'REQUEST_FAILED', role: 'api', method, statusCode: status, correlationId };
      if (status >= 500) this.logger.error(event);
      else this.logger.warn(event);
    } catch { /* Logging failure must not prevent the HTTP response. */ }
    if (!response.headersSent) {
      response.setHeader('X-Correlation-ID', correlationId);
      response.status(status).json(result);
    }
  }
}
