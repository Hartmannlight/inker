import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { newQuickJSWASMModule, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';
import { makeLiquid } from './guest-liquid';
import {
  ISOLATION_LIMITS, IsolatedExecutionError, validateIsolatedRequest,
  type IsolatedRequest, type IsolatedResponse, type IsolationErrorCode,
} from './isolation-contract';

let liquidBrowserSource: Promise<string> | undefined;
function loadLiquidBrowser(): Promise<string> {
  // A fixed installed asset, never a user-selected file.
  const installed = createRequire(__filename);
  return liquidBrowserSource ??= readFile(join(dirname(installed.resolve('liquidjs')), 'liquid.browser.umd.js'), 'utf8');
}

declare const createLiquidEngine: () => any;

/**
 * This trusted function's source runs only inside QuickJS. Do not capture host
 * functions/imports. Its primordials are lexical and inaccessible to the guest's
 * separately compiled Function. Objects never cross the boundary as live handles.
 */
function executeGuest(request: any, program: string, limits: any): string {
  'use strict';
  const compile = Function;
  const parse = JSON.parse, quote = JSON.stringify;
  const getPrototypeOf = Object.getPrototypeOf, descriptorsOf = Object.getOwnPropertyDescriptors;
  const ownKeys = Reflect.ownKeys, apply = Reflect.apply, isArray = Array.isArray;
  const charCodeAt = String.prototype.charCodeAt, numberToString = Number.prototype.toString;
  const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
  const finite = Number.isFinite, create = Object.create;
  const invalid = Symbol(), tooLarge = Symbol();
  const failed = '{"version":1,"ok":false,"code":"ISOLATION_FAILED"}';
  const invalidOutput = '{"version":1,"ok":false,"code":"ISOLATION_INVALID_OUTPUT"}';
  const outputLimit = '{"version":1,"ok":false,"code":"ISOLATION_OUTPUT_LIMIT"}';

  // Proxies are not data. Disable their constructor before user code can capture
  // it and disguise arbitrary traps as plain object descriptors.
  Object.defineProperty(globalThis, 'Proxy', { value: undefined, configurable: false, writable: false });
  for (const prototype of [Object.prototype, Array.prototype, Function.prototype,
    String.prototype, Number.prototype, Boolean.prototype, RegExp.prototype, Date.prototype]) {
    Object.freeze(prototype);
  }

  let value: any;
  try {
    const data = parse(request.data);
    if (request.kind === 'liquid') {
      // Neither API settings nor a settings key from snapshot data are exposed.
      data.settings = {};
      value = createLiquidEngine().parseAndRenderSync(request.code, data);
    } else {
      value = compile('$', '__create', program)(data, create);
    }
  } catch {
    return failed;
  }

  let bytes = 0;
  const budget = request.kind === 'liquid' ? limits.htmlBytes : limits.outputBytes;
  const ancestors: any[] = [];
  function add(text: string): string {
    for (let index = 0; index < text.length; index++) {
      const code = apply(charCodeAt, text, [index]);
      if (code < 0x80) bytes++;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
        && apply(charCodeAt, text, [index + 1]) >= 0xdc00 && apply(charCodeAt, text, [index + 1]) <= 0xdfff) {
        bytes += 4; index++;
      } else bytes += 3;
      if (bytes > budget) throw tooLarge;
    }
    return text;
  }
  function serialize(input: any, depth: number): string {
    if (input === null) return add('null');
    if (typeof input === 'boolean') return add(input ? 'true' : 'false');
    if (typeof input === 'string') {
      if (input.length > budget) throw tooLarge;
      // Quoting a primitive string cannot invoke a user toJSON/toString hook.
      return add(quote(input));
    }
    if (typeof input === 'number' && finite(input)) return add(apply(numberToString, input, []));
    if (!input || typeof input !== 'object' || depth >= limits.depth) throw invalid;
    for (let index = 0; index < ancestors.length; index++) if (ancestors[index] === input) throw invalid;
    const array = isArray(input), prototype = getPrototypeOf(input);
    if (array ? prototype !== arrayPrototype : prototype !== objectPrototype && prototype !== null) throw invalid;
    const descriptors = descriptorsOf(input), keys = ownKeys(descriptors);
    if (keys.length > budget / 2) throw tooLarge;
    ancestors[ancestors.length] = input;
    let result: string;
    if (array) {
      const length = descriptors.length.value;
      if (keys.length !== length + 1 || length > budget / 2) throw invalid;
      result = add('[');
      for (let index = 0; index < length; index++) {
        const property = descriptors[apply(numberToString, index, [])];
        if (!property || !property.enumerable || !('value' in property)) throw invalid;
        if (index) result += add(',');
        result += serialize(property.value, depth + 1);
      }
      result += add(']');
    } else {
      result = add('{');
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index], property = descriptors[key as any];
        if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype'
          || key === 'toJSON' || key === 'toString' || key === 'valueOf'
          || !property.enumerable || !('value' in property)) throw invalid;
        if (index) result += add(',');
        result += add(quote(key)) + add(':') + serialize(property.value, depth + 1);
      }
      result += add('}');
    }
    ancestors.length--;
    return result;
  }
  try {
    if (request.kind === 'liquid' && typeof value !== 'string') throw invalid;
    return '{"version":1,"ok":true,"value":' + serialize(value, 0) + '}';
  } catch (error) {
    return error === tooLarge ? outputLimit : invalidOutput;
  }
}

function javascriptProgram(request: IsolatedRequest): string {
  if (request.mode !== 'template') return request.code;
  const names = [...request.code.matchAll(/\b(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g)]
    .map(match => match[1]).filter(name => !name.startsWith('__'));
  const unique = [...new Set(names)];
  // Retain the legacy template-variable convention; only validated data returns.
  return request.code + '\n;const __variables = __create(null);\n' + unique.map(name =>
    'if (typeof ' + name + " !== 'undefined') __variables[" + JSON.stringify(name) + '] = ' + name + ';')
    .join('\n') + '\nreturn __variables;';
}

function failure(code: IsolationErrorCode): IsolatedResponse { return { version: 1, ok: false, code }; }

/** Called only by the disposable child process; direct use is for guest tests. */
export async function runGuest(input: IsolatedRequest): Promise<IsolatedResponse> {
  let request: IsolatedRequest;
  try { request = validateIsolatedRequest(input); }
  catch { return failure('ISOLATION_INVALID_INPUT'); }
  if (request.kind === 'liquid' && (/\|\s*where_exp\b/.test(request.code)
    || /\{%-?\s*(?:include|render|layout)\b/.test(request.code))) return failure('ISOLATION_FAILED');

  try {
    // setMemoryLimit alone does not cap aggregate allocations in the prebuilt
    // WASM allocator (upstream issue #255). Bound the entire linear memory and
    // instantiate a fresh module for each job, including after an OOM.
    const pages = ISOLATION_LIMITS.heapBytes / 65536;
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const QuickJS = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, {
      wasmMemory: memory,
      // Supported Emscripten hooks, omitted from the dependency's narrow typings.
      emscriptenModule: { print: () => {}, printErr: () => {} } as Parameters<typeof newVariant>[1]['emscriptenModule'],
    }));
    if (QuickJS.getWasmMemory() !== memory) return failure('ISOLATION_UNAVAILABLE');
    const liquid = request.kind === 'liquid' ? await loadLiquidBrowser() : '';
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(ISOLATION_LIMITS.heapBytes);
    runtime.setMaxStackSize(ISOLATION_LIMITS.stackBytes);
    let interrupted = false;
    const deadline = performance.now() + ISOLATION_LIMITS.cpuMs;
    runtime.setInterruptHandler(() => {
      interrupted ||= performance.now() >= deadline;
      return interrupted;
    });
    const context = runtime.newContext();
    try {
      // No module loader and no host functions/handles registered in this realm.
      const data = { kind: request.kind, code: request.code, data: JSON.stringify(request.data) };
      const setup = request.kind === 'liquid' ? '\nconst createLiquidEngine = ' + makeLiquid.toString() + ';\n' : '';
      const source = liquid + setup + '\n(' + executeGuest.toString() + ')('
        + JSON.stringify(data) + ',' + JSON.stringify(javascriptProgram(request)) + ',' + JSON.stringify(ISOLATION_LIMITS) + ');';
      const result = context.evalCode(source, 'isolated-guest.js');
      if (result.error) {
        result.error.dispose(); // Never dump exceptions or inspect their properties.
        return failure(interrupted ? 'ISOLATION_TIMEOUT' : 'ISOLATION_MEMORY_LIMIT');
      }
      try {
        if (interrupted) return failure('ISOLATION_TIMEOUT');
        if (context.typeof(result.value) !== 'string') return failure('ISOLATION_INVALID_OUTPUT');
        const serialized = context.getString(result.value);
        if (Buffer.byteLength(serialized) > ISOLATION_LIMITS.responseBytes) return failure('ISOLATION_OUTPUT_LIMIT');
        return JSON.parse(serialized) as IsolatedResponse;
      } finally { result.value.dispose(); }
    } finally { context.dispose(); runtime.dispose(); }
  } catch (error) {
    return failure(error instanceof IsolatedExecutionError ? error.code : 'ISOLATION_FAILED');
  }
}
