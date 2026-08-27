import { describe, expect, test } from 'bun:test';
import { comparePresentationRevisions, parseDeviceClientMessage, parseDeviceServerMessage } from '../src/websocket';

describe('device WebSocket v1 boundary', () => {
  test('orders render completions within a desired revision, with legacy generation zero', () => {
    expect(comparePresentationRevisions({ revision: 2 }, { revision: 2, renderRevision: 0 })).toBe(0);
    expect(comparePresentationRevisions({ revision: 2, renderRevision: 1 }, { revision: 2 })).toBe(1);
    expect(comparePresentationRevisions({ revision: 2 }, { revision: 2, renderRevision: 1 })).toBe(-1);
    expect(comparePresentationRevisions({ revision: 3, renderRevision: 0 }, { revision: 2, renderRevision: 99 })).toBe(1);
    expect(comparePresentationRevisions({ revision: 1, renderRevision: 99 }, { revision: 2 })).toBe(-1);
  });

  test('accepts optional nonnegative render revisions without changing legacy projection', () => {
    const presentation = { deviceId: 1, externalId: 'screen', revision: 2, generatedAt: '2026-08-27T00:00:00Z', nextTransitionAt: null,
      viewport: { width: 800, height: 480 }, content: { kind: 'image', url: '/assets/screen.png', title: 'Screen', fit: 'contain', background: '#ffffff' } } as const;
    const parse = (value: unknown) => parseDeviceServerMessage({ protocolVersion: '1.0', type: 'presentation.changed', presentation: value });
    const legacy = parse(presentation);
    expect(legacy.success && legacy.data.type === 'presentation.changed' && legacy.data.presentation).toEqual(presentation);
    for (const renderRevision of [0, 1, Number.MAX_SAFE_INTEGER]) {
      const parsed = parse({ ...presentation, renderRevision });
      expect(parsed.success && parsed.data.type === 'presentation.changed' && parsed.data.presentation.renderRevision).toBe(renderRevision);
    }
    for (const renderRevision of [-1, 1.5, null, '1', NaN, Number.MAX_SAFE_INTEGER + 1]) expect(parse({ ...presentation, renderRevision }).success).toBe(false);
  });
  test('auth and compatible minor versions, never echo invalid values', () => {
    for (const protocolVersion of ['1.0', '1.7']) {
      expect(parseDeviceClientMessage({ protocolVersion, type: 'authenticate', externalId: 'screen', token: 'a'.repeat(64) }).success).toBe(true);
    }
    for (const protocolVersion of [undefined, '2.0', 'secret-value', 1]) {
      const result = parseDeviceClientMessage({ protocolVersion, type: 'authenticate', externalId: 'screen', token: 'a'.repeat(64) });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain('secret-value');
    }
  });
  test('rejects unknown messages, malformed payloads and unbounded/string telemetry', () => {
    for (const value of [null, [], {}, { type: 'commands' },
      { type: 'telemetry', payload: { width: -1 } },
      { type: 'telemetry', payload: { userAgent: 'credential-secret' } },
      { type: 'telemetry', payload: { width: 1.5 } },
      { type: 'telemetry', payload: { batteryPercent: 101 } },
      { type: 'telemetry', payload: {} },
      { type: 'pong', nonce: '' },
    ]) expect(parseDeviceClientMessage({ protocolVersion: '1.0', ...value }).success).toBe(false);
  });
  test('projects known fields instead of retaining unknown minor-version metadata', () => {
    const result = parseDeviceClientMessage({ protocolVersion: '1.3', type: 'telemetry', payload: { width: 800, height: 480 }, token: 'secret' });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  test('validates server ping and legacy presentation envelope; prohibits credential URLs', () => {
    expect(parseDeviceServerMessage({ protocolVersion: '1.0', type: 'ping', nonce: 'abc', timestamp: 42 }).success).toBe(true);
    const presentation = { deviceId: 1, externalId: 'screen', revision: 2, generatedAt: '2026-08-27T00:00:00Z', nextTransitionAt: null,
      viewport: { width: 800, height: 480 }, content: { kind: 'image', url: '/api/device-images/device/1?t=2', title: 'Screen', fit: 'contain', background: '#ffffff' } };
    expect(parseDeviceServerMessage({ protocolVersion: '1.0', type: 'presentation.changed', presentation }).success).toBe(true);
    expect(parseDeviceServerMessage({ protocolVersion: '1.0', type: 'presentation.changed', presentation: { ...presentation,
      content: { ...presentation.content, url: `/api/web-displays/screen/artifacts/${'a'.repeat(64)}` } } }).success).toBe(true);
    for (const url of ['/image?token=secret', 'https://user:secret@example.com/img', '//example.com/img', '/image?credential=secret',
      `/api/web-displays/screen/artifacts/${'a'.repeat(64)}?t=2`, '/api/web-displays/screen/pair', '/api/web-displays/../artifacts/hash']) {
      expect(parseDeviceServerMessage({ protocolVersion: '1.0', type: 'presentation.changed', presentation: { ...presentation, content: { ...presentation.content, url } } }).success).toBe(false);
    }
  });
});
