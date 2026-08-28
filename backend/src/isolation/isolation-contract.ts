import { types } from 'node:util';
import type { JsonValue } from '@inker/contracts';
import { redactLogValue } from '../config/secret-redaction';

export const ISOLATION_LIMITS = Object.freeze({
  cpuMs: 1000, wallMs: 2500, heapBytes: 32 * 1024 * 1024, stackBytes: 512 * 1024,
  dataBytes: 64 * 1024, outputBytes: 64 * 1024, htmlBytes: 256 * 1024,
  requestBytes: 256 * 1024, responseBytes: 512 * 1024, codeChars: 10_000,
  liquidBytes: 128 * 1024, depth: 16, concurrency: 2, pending: 16,
});
export const ISOLATION_ERROR_CODES = [
  'ISOLATION_INVALID_INPUT', 'ISOLATION_BUSY', 'ISOLATION_TIMEOUT', 'ISOLATION_ABORTED',
  'ISOLATION_FAILED', 'ISOLATION_INVALID_OUTPUT', 'ISOLATION_OUTPUT_LIMIT',
  'ISOLATION_MEMORY_LIMIT', 'ISOLATION_CRASH', 'ISOLATION_UNAVAILABLE',
] as const;
export type IsolationErrorCode = typeof ISOLATION_ERROR_CODES[number];
export type IsolatedRequest = {
  version: 1; kind: 'javascript' | 'liquid'; code: string; data: JsonValue; mode?: 'value' | 'template';
};
export type IsolatedResponse = { version: 1; ok: true; value: JsonValue }
  | { version: 1; ok: false; code: IsolationErrorCode };
export class IsolatedExecutionError extends Error {
  constructor(readonly code: IsolationErrorCode) { super(code); this.name = 'IsolatedExecutionError'; }
}
const forbidden = new Set(['__proto__', 'constructor', 'prototype', 'toJSON', 'toString', 'valueOf']);

/** Never invoke caller getters, proxies or serialization hooks on a trusted event loop. */
export function cloneIsolatedJson(value: unknown, maxBytes = ISOLATION_LIMITS.dataBytes): JsonValue {
  let bytes = 0;
  const ancestors = new Set<object>();
  const fail = (): never => { throw new IsolatedExecutionError('ISOLATION_INVALID_INPUT'); };
  const add = (count: number) => { bytes += count; if (bytes > maxBytes) fail(); };
  const string = (input: string) => {
    if (input.length > maxBytes) fail();
    add(Buffer.byteLength(JSON.stringify(input)));
  };
  const copy = (input: unknown, depth: number): JsonValue => {
    if (input === null) { add(4); return null; }
    if (typeof input === 'string') { string(input); return input; }
    if (typeof input === 'boolean') { add(input ? 4 : 5); return input; }
    if (typeof input === 'number' && Number.isFinite(input)) { add(String(input).length); return input === 0 ? 0 : input; }
    if (!input || typeof input !== 'object' || types.isProxy(input) || depth >= ISOLATION_LIMITS.depth
      || ancestors.has(input) || Object.getOwnPropertySymbols(input).length) return fail();
    const array = Array.isArray(input), prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return fail();
    if (array && (input as unknown[]).length > maxBytes / 2) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.keys(descriptors);
    if (keys.length > maxBytes / 2) return fail();
    ancestors.add(input);
    try {
      if (array) {
        const length = (input as unknown[]).length;
        if (keys.length !== length + 1 || length > maxBytes / 2) return fail();
        add(2 + Math.max(0, length - 1));
        const result: JsonValue[] = [];
        for (let index = 0; index < length; index++) {
          const property = descriptors[String(index)];
          if (!property?.enumerable || !('value' in property)) return fail();
          result.push(copy(property.value, depth + 1));
        }
        return result;
      }
      add(2 + Math.max(0, keys.length - 1));
      const result: Record<string, JsonValue> = {};
      for (const key of keys) {
        const property = descriptors[key];
        if (forbidden.has(key) || !property.enumerable || !('value' in property)) return fail();
        string(key); add(1); result[key] = copy(property.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(input); }
  };
  return copy(value, 0);
}

export function validateIsolatedRequest(input: unknown): IsolatedRequest {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length) {
    throw new IsolatedExecutionError('ISOLATION_INVALID_INPUT');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.entries(descriptors).some(([key, item]) => !['version', 'kind', 'code', 'data', 'mode'].includes(key)
    || !item.enumerable || !('value' in item))) throw new IsolatedExecutionError('ISOLATION_INVALID_INPUT');
  const version = descriptors.version?.value, kind = descriptors.kind?.value, code = descriptors.code?.value;
  const mode = descriptors.mode?.value;
  if (version !== 1 || !['javascript', 'liquid'].includes(kind) || typeof code !== 'string'
    || (kind === 'javascript' ? code.length > ISOLATION_LIMITS.codeChars : Buffer.byteLength(code) > ISOLATION_LIMITS.liquidBytes)
    || (mode !== undefined && !['value', 'template'].includes(mode)) || !descriptors.data) {
    throw new IsolatedExecutionError('ISOLATION_INVALID_INPUT');
  }
  const data = redactLogValue(cloneIsolatedJson(descriptors.data.value)) as JsonValue;
  if (kind === 'liquid' && (!data || typeof data !== 'object' || Array.isArray(data))) throw new IsolatedExecutionError('ISOLATION_INVALID_INPUT');
  return { version, kind, code, data, ...(mode ? { mode } : {}) };
}
