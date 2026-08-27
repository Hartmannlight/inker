import type { JsonValue } from '@inker/contracts';
import { types } from 'node:util';

export type ConnectorType = 'fixture' | 'slow' | 'failure';
export interface ConnectorConfiguration {
  data: JsonValue;
  delayMs?: number;
  /** Omitted means permanent failure; attempts 1..N fail before recovery. */
  failuresBeforeSuccess?: number;
}
export interface ConnectorContext { signal: AbortSignal; attempt: number; secret?: string; }
export interface ConnectorResult { data: JsonValue; sourceTimestamp?: string; connectorVersion: string; }

export const MAX_CONNECTOR_DATA_BYTES = 64 * 1024;
export const MAX_CONNECTOR_DATA_DEPTH = 16;
const INVALID_CONFIG = 'SOURCE_CONNECTOR_INVALID_CONFIG';
const INVALID_RESULT = 'SOURCE_CONNECTOR_INVALID_RESULT';
const forbiddenKeys = new Set([
  '__proto__', 'prototype', 'constructor', 'toJSON', 'toString', 'valueOf',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
]);

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return /password|passphrase|secret|token|credential|authorization|cookie|apikey|privatekey|encryptionkey|httpid/.test(normalized)
    || /^(?:admin|device|user)?pin$/.test(normalized);
}
function invalid(code: string): never { throw new Error(code); }

function record(value: unknown, code: string): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return invalid(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return invalid(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (forbiddenKeys.has(key) || !descriptor.enumerable || !('value' in descriptor)) return invalid(code);
  }
  return descriptors;
}

/** Clone without invoking getters/toJSON, while accounting for actual UTF-8 JSON. */
function copyData(value: unknown, code: string, secret?: string): JsonValue {
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (count: number) => {
    bytes += count;
    if (bytes > MAX_CONNECTOR_DATA_BYTES) invalid(code);
  };
  const stringBytes = (text: string) => {
    if (text.length > MAX_CONNECTOR_DATA_BYTES || secret && text.includes(secret)) invalid(code);
    return Buffer.byteLength(JSON.stringify(text), 'utf8');
  };
  const visit = (input: unknown, depth: number): JsonValue => {
    if (input === null) { add(4); return null; }
    if (typeof input === 'string') { add(stringBytes(input)); return input; }
    if (typeof input === 'boolean') { add(input ? 4 : 5); return input; }
    if (typeof input === 'number' && Number.isFinite(input)) { add(String(input).length); return input === 0 ? 0 : input; }
    if (!input || typeof input !== 'object' || types.isProxy(input)
      || depth >= MAX_CONNECTOR_DATA_DEPTH || ancestors.has(input)) return invalid(code);
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype || input.length > MAX_CONNECTOR_DATA_BYTES / 2
          || Object.getOwnPropertySymbols(input).length) return invalid(code);
        const descriptors = Object.getOwnPropertyDescriptors(input);
        if (Object.keys(descriptors).length !== input.length + 1) return invalid(code);
        add(2 + Math.max(0, input.length - 1));
        const result: JsonValue[] = [];
        for (let index = 0; index < input.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalid(code);
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const descriptors = record(input, code);
      const entries = Object.entries(descriptors);
      add(2 + Math.max(0, entries.length - 1));
      const result: { [key: string]: JsonValue } = {};
      for (const [key, descriptor] of entries) {
        if (sensitiveKey(key)) return invalid(code);
        add(stringBytes(key) + 1);
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(input); }
  };
  return visit(value, 0);
}

export function validateConnectorConfiguration(type: ConnectorType, config: unknown): ConnectorConfiguration {
  if (!['fixture', 'slow', 'failure'].includes(type)) return invalid(INVALID_CONFIG);
  const properties = record(config, INVALID_CONFIG);
  const allowed = ['data', ...(type === 'slow' ? ['delayMs'] : []), ...(type === 'failure' ? ['failuresBeforeSuccess'] : [])];
  if (!properties.data || Object.keys(properties).some(key => !allowed.includes(key))) return invalid(INVALID_CONFIG);
  const result: ConnectorConfiguration = { data: copyData(properties.data.value, INVALID_CONFIG) };
  if (type === 'slow') {
    const delayMs = properties.delayMs ? properties.delayMs.value : 60_000;
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) return invalid(INVALID_CONFIG);
    result.delayMs = delayMs;
  }
  if (properties.failuresBeforeSuccess) {
    const failures = properties.failuresBeforeSuccess.value;
    if (!Number.isSafeInteger(failures) || failures < 0 || failures > 100) return invalid(INVALID_CONFIG);
    result.failuresBeforeSuccess = failures;
  }
  return result;
}

/** Persistence boundary for built-in results, including an optional synthetic secret check. */
export function validateConnectorResult(value: unknown, secret?: string): ConnectorResult {
  if (secret !== undefined && typeof secret !== 'string') return invalid(INVALID_RESULT);
  const properties = record(value, INVALID_RESULT);
  if (Object.keys(properties).some(key => !['data', 'sourceTimestamp', 'connectorVersion'].includes(key))
    || !properties.data || typeof properties.connectorVersion?.value !== 'string'
    || !/^builtin-(fixture|slow|failure)-v1$/.test(properties.connectorVersion.value)) return invalid(INVALID_RESULT);
  const connectorVersion = properties.connectorVersion.value as string;
  const result: ConnectorResult = { data: copyData(properties.data.value, INVALID_RESULT, secret), connectorVersion };
  if (properties.sourceTimestamp) {
    const timestamp = properties.sourceTimestamp.value;
    // Built-in sources use canonical UTC timestamps only; no local-clock guesses.
    if (typeof timestamp !== 'string' || timestamp.length !== 24 || !Number.isFinite(Date.parse(timestamp))
      || new Date(timestamp).toISOString() !== timestamp) return invalid(INVALID_RESULT);
    result.sourceTimestamp = timestamp;
  }
  if (secret && JSON.stringify(result).includes(secret)) return invalid(INVALID_RESULT);
  return result;
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) invalid('SOURCE_CONNECTOR_ABORTED');
}
function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    };
    const aborted = () => { cleanup(); reject(new Error('SOURCE_CONNECTOR_ABORTED')); };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
  });
}

/** Trusted fixture code only: no network, filesystem, provider or plugin execution. */
export async function runConnector(type: ConnectorType, config: unknown, context: ConnectorContext): Promise<ConnectorResult> {
  if (!context) return invalid('SOURCE_CONNECTOR_INVALID_CONTEXT');
  const { signal, attempt, secret } = context;
  if (!(signal instanceof AbortSignal) || !Number.isSafeInteger(attempt) || attempt < 1
    || secret !== undefined && typeof secret !== 'string') return invalid('SOURCE_CONNECTOR_INVALID_CONTEXT');
  checkAbort(signal);
  // Snapshot configuration before waiting: caller mutations cannot alter a run.
  const normalized = validateConnectorConfiguration(type, config);
  if (type === 'slow' && normalized.delayMs! > 0) await wait(normalized.delayMs!, signal);
  checkAbort(signal);
  if (type === 'failure' && (normalized.failuresBeforeSuccess === undefined || attempt <= normalized.failuresBeforeSuccess)) {
    return invalid('SOURCE_CONNECTOR_FAILURE');
  }
  return validateConnectorResult({ data: normalized.data, connectorVersion: `builtin-${type}-v1` }, secret);
}
