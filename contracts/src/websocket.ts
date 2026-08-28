import { assessProtocolVersion, type ProtocolVersion } from './protocol';
import type { ParseResult } from './validation';

export const DEVICE_WEBSOCKET_LIMITS = {
  maxMessageBytes: 8192, burstMessages: 20, messagesPerSecond: 2,
  authTimeoutMs: 10_000, heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000,
  credentialCheckIntervalMs: 10_000, operationTimeoutMs: 5_000,
  maxPendingMessages: 8, maxConnections: 1024, maxConnectionsPerDevice: 4,
  maxBufferedBytes: 262_144, minTelemetryIntervalSeconds: 60,
} as const;

/** No free-form strings: credentials cannot be smuggled into persisted telemetry. */
export interface DeviceTelemetry {
  width?: number;
  height?: number;
  batteryPercent?: number;
  rssi?: number;
  uptimeSeconds?: number;
}

/** Existing browser presentation, explicitly separate from the publication manifest. */
export interface WebDisplayManifest {
  deviceId: number;
  externalId: string;
  revision: number;
  /** Monotone render completion generation; absent legacy values mean zero. */
  renderRevision?: number;
  generatedAt: string;
  nextTransitionAt: string | null;
  content: { kind: 'image'; url: string; title: string; fit: 'contain' | 'cover' | 'fill'; background: string };
  viewport: { width: number; height: number };
}

/** Compare desired assignment first, then its render generation. */
export function comparePresentationRevisions(
  left: Pick<WebDisplayManifest, 'revision' | 'renderRevision'>,
  right: Pick<WebDisplayManifest, 'revision' | 'renderRevision'>,
): -1 | 0 | 1 {
  if (left.revision !== right.revision) return left.revision < right.revision ? -1 : 1;
  const leftRender = left.renderRevision ?? 0;
  const rightRender = right.renderRevision ?? 0;
  return leftRender < rightRender ? -1 : leftRender > rightRender ? 1 : 0;
}

interface Envelope { protocolVersion: ProtocolVersion }
export type DeviceClientMessage = Envelope & (
  | { type: 'authenticate'; externalId: string; token: string; viewport?: DeviceTelemetry }
  | { type: 'pong'; nonce: string }
  | { type: 'telemetry'; payload: DeviceTelemetry }
);
export type DeviceServerMessage = Envelope & (
  | { type: 'connected'; deviceId: number; heartbeatInterval: number; pongTimeout: number; telemetryInterval: number }
  | { type: 'ping'; nonce: string; timestamp: number }
  | { type: 'presentation.changed'; presentation: WebDisplayManifest }
  | { type: 'timers.changed' }
);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.length || value.length > max || (pattern && !pattern.test(value))) throw new Error();
  return value;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error();
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value, 40);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error();
  return result;
}
function telemetry(value: unknown): DeviceTelemetry {
  const r = record(value);
  const fields = { width: [1, 16384], height: [1, 16384], batteryPercent: [0, 100], rssi: [-127, 0], uptimeSeconds: [0, 4294967295] };
  const result: Record<string, number> = {};
  // Telemetry is an intentional stricter privacy boundary, even with a newer minor.
  for (const key of Object.keys(r)) if (!Object.hasOwn(fields, key)) throw new Error();
  for (const [key, [min, max]] of Object.entries(fields)) if (r[key] !== undefined) result[key] = integer(r[key], min, max);
  if (!Object.keys(result).length) throw new Error();
  return result;
}

function manifest(value: unknown): WebDisplayManifest {
  const r = record(value), content = record(r.content), viewport = record(r.viewport);
  const url = text(content.url, 2048);
  // The compatibility path only needs local images and known non-secret render parameters.
  const publicationArtifact = /^\/api\/web-displays\/[A-Za-z0-9_-]+\/artifacts\/[a-f0-9]{64}$/.test(url);
  if ((!publicationArtifact && !/^\/(?:uploads\/|assets\/|api\/device-images\/|api\/plugins\/instances\/)[A-Za-z0-9_./%?=&+-]+$/.test(url)) || /%2f|%5c|\.\./i.test(url)) throw new Error();
  const [path, query] = url.split('?');
  if (!path || url.split('?').length > 2) throw new Error();
  if (query) for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    if (!['mode', 't', 'deviceName'].includes(key) || !value) throw new Error();
  }
  const fit = text(content.fit, 8);
  if (content.kind !== 'image' || !['contain', 'cover', 'fill'].includes(fit)) throw new Error();
  return {
    deviceId: integer(r.deviceId, 1), externalId: text(r.externalId, 128, /^[A-Za-z0-9_-]+$/),
    revision: integer(r.revision, 0), generatedAt: timestamp(r.generatedAt),
    ...(r.renderRevision === undefined ? {} : { renderRevision: integer(r.renderRevision, 0) }),
    nextTransitionAt: r.nextTransitionAt === null ? null : timestamp(r.nextTransitionAt),
    content: { kind: 'image', url, title: text(content.title, 512), fit: fit as WebDisplayManifest['content']['fit'], background: text(content.background, 64) },
    viewport: { width: integer(viewport.width, 1, 16384), height: integer(viewport.height, 1, 16384) },
  };
}

function parse<T>(value: unknown, project: (r: Record<string, unknown>, protocolVersion: ProtocolVersion) => T): ParseResult<T> {
  try {
    const r = record(value);
    const compatibility = assessProtocolVersion(r.protocolVersion);
    if (compatibility.status === 'malformed' || compatibility.status === 'incompatible' || !compatibility.version) {
      return { success: false, errors: [{ code: 'unsupported_protocol', path: '$.protocolVersion', severity: 'error', message: 'Unsupported device protocol version.' }], warnings: [] };
    }
    const data = project(r, compatibility.version);
    return { success: true, data, warnings: compatibility.status === 'unknown-compatible'
      ? [{ code: 'protocol_unknown_minor', path: '$.protocolVersion', severity: 'warning', message: 'Only known v1 features are used.' }] : [] };
  } catch {
    return { success: false, errors: [{ code: 'invalid_message', path: '$', severity: 'error', message: 'Invalid device message.' }], warnings: [] };
  }
}

export function parseDeviceClientMessage(value: unknown): ParseResult<DeviceClientMessage> {
  return parse(value, (r, protocolVersion): DeviceClientMessage => {
    switch (r.type) {
      case 'authenticate': return { protocolVersion, type: r.type,
        externalId: text(r.externalId, 128, /^[A-Za-z0-9_-]+$/), token: text(r.token, 256, /^[A-Za-z0-9_-]{32,256}$/),
        ...(r.viewport === undefined ? {} : { viewport: telemetry(r.viewport) }) };
      case 'pong': return { protocolVersion, type: r.type, nonce: text(r.nonce, 64, /^[A-Za-z0-9_-]+$/) };
      case 'telemetry': return { protocolVersion, type: r.type, payload: telemetry(r.payload) };
      default: throw new Error();
    }
  });
}

export function parseDeviceServerMessage(value: unknown): ParseResult<DeviceServerMessage> {
  return parse(value, (r, protocolVersion): DeviceServerMessage => {
    switch (r.type) {
      case 'connected': return { protocolVersion, type: r.type, deviceId: integer(r.deviceId, 1),
        heartbeatInterval: integer(r.heartbeatInterval, 1000, 300000), pongTimeout: integer(r.pongTimeout, 1000, 60000),
        telemetryInterval: integer(r.telemetryInterval, 60000, 2147483647) };
      case 'ping': return { protocolVersion, type: r.type, nonce: text(r.nonce, 64, /^[A-Za-z0-9_-]+$/), timestamp: integer(r.timestamp, 0) };
      case 'presentation.changed': return { protocolVersion, type: r.type, presentation: manifest(r.presentation) };
      case 'timers.changed':
        if (Reflect.ownKeys(r).some(key => typeof key !== 'string' || !['protocolVersion', 'type'].includes(key))) throw new Error();
        return { protocolVersion, type: r.type };
      default: throw new Error();
    }
  });
}
