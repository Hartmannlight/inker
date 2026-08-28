import { describe, expect, it } from 'bun:test';
import {
  FEDERATION_LIMITS, parseFederationCapabilities, parseFederationPublicationFeed,
  type FederationArtifact, type FederationCapabilities, type FederationPublicationFeed,
} from '../src/federation';

const serverId = '61b097fc-51f7-4d41-b50f-5459605b6d99';
function artifact(index = 1): FederationArtifact {
  const sha256 = index.toString(16).padStart(64, '0');
  return { artifactId: sha256, sha256, mimeType: 'image/png', format: 'png', width: 800, height: 480,
    colorSpace: 'monochrome', bitDepth: 1, rotation: 0, sizeBytes: 512,
    url: `/api/federation/v1/publications/cpublication1/revisions/3/artifacts/${sha256}` };
}
function feed(): FederationPublicationFeed {
  return { protocolVersion: '1.0', serverId, publicationId: 'cpublication1', publicationRevisionId: 'crevision3',
    revision: 3, publishedAt: '2026-08-28T00:00:00.000Z', artifacts: [artifact()] };
}
function capabilities(): FederationCapabilities {
  return { protocolVersion: '1.0', serverId, readOnly: true, features: ['publication-feed', 'immutable-artifacts'],
    limits: { manifestBytes: 65_536, artifactBytes: 2_097_152, artifacts: 8 } };
}
function expectInvalid(input: unknown): void {
  const result = parseFederationPublicationFeed(input);
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain('synthetic-secret');
}

describe('federation metadata contract', () => {
  it('projects valid capabilities and a bounded immutable publication feed into detached data', () => {
    const input = feed(), caps = capabilities();
    const result = parseFederationPublicationFeed(input), capability = parseFederationCapabilities(caps);
    expect(result).toEqual({ success: true, data: input, warnings: [] });
    expect(capability).toEqual({ success: true, data: caps, warnings: [] });
    if (!result.success || !capability.success) throw new Error('Expected valid fixture');
    input.artifacts[0].width = 99; caps.features.pop();
    expect(result.data.artifacts[0].width).toBe(800);
    expect(capability.data.features).toEqual(['publication-feed', 'immutable-artifacts']);
    result.data.artifacts[0].height = 100;
    expect(input.artifacts[0].height).toBe(480);
  });

  it('ignores unknown minor fields and capabilities without leaking their values', () => {
    const input = { ...feed(), protocolVersion: '1.7', sourceMetadata: { token: 'synthetic-secret' },
      artifacts: [{ ...artifact(), actions: ['synthetic-secret'] }] };
    const result = parseFederationPublicationFeed(input);
    const capability = parseFederationCapabilities({ ...capabilities(), protocolVersion: '1.1',
      features: ['immutable-artifacts', 'future-feature', 'publication-feed'],
      limits: { ...capabilities().limits, futureLimit: 1 }, commands: 'synthetic-secret' });
    expect(result.success).toBe(true); expect(capability.success).toBe(true);
    expect(JSON.stringify([result, capability])).not.toContain('synthetic-secret');
    if (!result.success || !capability.success) throw new Error('Expected compatible minor');
    expect(result.warnings.map(issue => issue.code)).toEqual(['protocol_unknown_minor']);
    expect(result.data).toEqual({ ...feed(), protocolVersion: '1.7' });
    expect(capability.data).toEqual({ ...capabilities(), protocolVersion: '1.1' });
  });

  it('rejects unsupported major versions, malformed versions and unversioned extensions', () => {
    for (const protocolVersion of ['2.0', '0.9', '01.0', '1', '1.01', '1.-1', 1, null, 'synthetic-secret', '1.' + '9'.repeat(80)]) {
      expectInvalid({ ...feed(), protocolVersion });
      expect(parseFederationCapabilities({ ...capabilities(), protocolVersion }).success).toBe(false);
    }
    expectInvalid({ ...feed(), actions: [] });
    expectInvalid({ ...feed(), artifacts: [{ ...artifact(), sourceId: 'synthetic-secret' }] });
    expect(parseFederationCapabilities({ ...capabilities(), extra: true }).success).toBe(false);
    expect(parseFederationCapabilities({ ...capabilities(), limits: { ...capabilities().limits, extra: true } }).success).toBe(false);
  });

  it('requires all fields, stable identifiers, canonical timestamps and bounded positive revisions', () => {
    for (const key of Object.keys(feed())) {
      const input: Record<string, unknown> = { ...feed() }; delete input[key]; expectInvalid(input);
    }
    for (const key of Object.keys(artifact())) {
      const input: Record<string, unknown> = { ...artifact() }; delete input[key];
      expectInvalid({ ...feed(), artifacts: [input] });
    }
    for (const server of [serverId.toUpperCase(), '', 'local-server', '../synthetic-secret']) expectInvalid({ ...feed(), serverId: server });
    for (const id of ['', 'x'.repeat(101), '../synthetic-secret', 'one/two', 'two words', 'a_b', 'a.b']) {
      expectInvalid({ ...feed(), publicationId: id }); expectInvalid({ ...feed(), publicationRevisionId: id });
    }
    for (const revision of [0, -1, 1.5, Infinity, 2_147_483_648, '3']) expectInvalid({ ...feed(), revision });
    for (const publishedAt of ['2026-08-28', '2026-08-28T00:00:00Z', '2026-08-28T02:00:00.000+02:00',
      '2026-02-30T00:00:00.000Z', '1969-12-31T23:59:59.999Z', '+010000-01-01T00:00:00.000Z']) expectInvalid({ ...feed(), publishedAt });
    expect(parseFederationPublicationFeed({ ...feed(), publishedAt: '1970-01-01T00:00:00.000Z' }).success).toBe(true);
    expect(parseFederationPublicationFeed({ ...feed(), publishedAt: '9999-12-31T23:59:59.999Z' }).success).toBe(true);
    const publicationId = 'X-'.repeat(50), revision = FEDERATION_LIMITS.maxRevision;
    expect(parseFederationPublicationFeed({ ...feed(), publicationId, publicationRevisionId: publicationId, revision,
      artifacts: [{ ...artifact(), url: `/api/federation/v1/publications/${publicationId}/revisions/${revision}/artifacts/${artifact().sha256}` }] }).success).toBe(true);
  });

  it('requires read-only publication/artifact capabilities and exact v1 resource budgets', () => {
    for (const key of Object.keys(capabilities())) {
      const input: Record<string, unknown> = { ...capabilities() }; delete input[key];
      expect(parseFederationCapabilities(input).success).toBe(false);
    }
    for (const patch of [{ readOnly: false }, { readOnly: 'true' }, { serverId: 'invalid' }, { features: [] },
      { features: ['publication-feed'] }, { features: ['publication-feed', 'immutable-artifacts', 'commands'] },
      { features: ['publication-feed', 'publication-feed', 'immutable-artifacts'] },
      { limits: { ...capabilities().limits, artifactBytes: 2_097_153 } },
      { limits: { ...capabilities().limits, artifacts: 9 } }]) {
      expect(parseFederationCapabilities({ ...capabilities(), ...patch }).success).toBe(false);
    }
    expect(parseFederationCapabilities({ ...capabilities(), protocolVersion: '1.1', features: ['future-feature'] }).success).toBe(false);
  });

  it('enforces exact content hash identity and relative publication/revision-bound artifact paths', () => {
    const valid = artifact();
    for (const url of ['https://example.test' + valid.url, '//example.test' + valid.url, valid.url + '?token=synthetic-secret',
      valid.url + '#fragment', valid.url.replace('/3/', '/4/'), valid.url.replace('cpublication1', 'other'),
      valid.url.replace('/artifacts/', '/%61rtifacts/'), valid.url.replaceAll('/', '\\'),
      valid.url.replace('/3/', '/03/'), valid.url + '/..', valid.url.replace(valid.sha256, 'f'.repeat(64))]) {
      expectInvalid({ ...feed(), artifacts: [{ ...valid, url }] });
    }
    for (const patch of [{ artifactId: 'f'.repeat(64) }, { sha256: 'F'.repeat(64) }, { sha256: 'a'.repeat(63) },
      { sha256: 'synthetic-secret' }]) expectInvalid({ ...feed(), artifacts: [{ ...valid, ...patch }] });
  });

  it('accepts existing PNG/BMP1 precision combinations and rejects mismatched formats/MIME/rotation', () => {
    for (const [colorSpace, depths] of [['monochrome', [1]], ['grayscale', [1, 2, 4, 8]], ['rgb', [8, 16, 24]]] as const) {
      for (const bitDepth of depths) for (const rotation of [0, 90, 180, 270]) {
        expect(parseFederationPublicationFeed({ ...feed(), artifacts: [{ ...artifact(), colorSpace, bitDepth, rotation }] }).success).toBe(true);
      }
    }
    expect(parseFederationPublicationFeed({ ...feed(), artifacts: [{ ...artifact(), format: 'bmp1', mimeType: 'image/bmp' }] }).success).toBe(true);
    for (const patch of [{ format: 'jpeg', mimeType: 'image/jpeg' }, { format: 'html', mimeType: 'text/html' },
      { format: 'bmp4', mimeType: 'image/bmp' }, { format: 'bmp1', mimeType: 'image/png' },
      { format: 'bmp1', mimeType: 'image/bmp', colorSpace: 'grayscale' }, { mimeType: 'image/svg+xml' },
      { colorSpace: 'rgb', bitDepth: 1 }, { colorSpace: 'monochrome', bitDepth: 8 },
      { colorSpace: 'grayscale', bitDepth: 16 }, { colorSpace: 'unknown' }, { bitDepth: 1.5 }, { rotation: 360 }]) {
      expectInvalid({ ...feed(), artifacts: [{ ...artifact(), ...patch }] });
    }
  });

  it('bounds dimensions, pixels, artifact count, individual bytes and aggregate bytes including exact limits', () => {
    expect(parseFederationPublicationFeed({ ...feed(), artifacts: [{ ...artifact(), width: 8192, height: 2048,
      sizeBytes: FEDERATION_LIMITS.artifactBytes }] }).success).toBe(true);
    for (const patch of [{ width: 0 }, { width: 8193 }, { height: 0 }, { height: 8193 }, { width: 1.5 },
      { width: 8192, height: 2049 }, { sizeBytes: 0 }, { sizeBytes: 2_097_153 }, { sizeBytes: 0.5 }]) {
      expectInvalid({ ...feed(), artifacts: [{ ...artifact(), ...patch }] });
    }
    const max = Array.from({ length: 8 }, (_, index) => ({ ...artifact(index + 1), sizeBytes: 1_048_576 }));
    expect(parseFederationPublicationFeed({ ...feed(), artifacts: max }).success).toBe(true);
    expectInvalid({ ...feed(), artifacts: max.map((entry, index) => ({ ...entry, sizeBytes: entry.sizeBytes + (index === 0 ? 1 : 0) })) });
    expectInvalid({ ...feed(), artifacts: [...max, artifact(9)] });
    expectInvalid({ ...feed(), artifacts: [] });
    expectInvalid({ ...feed(), artifacts: [artifact(), artifact()] });
  });

  it('counts ignored future extensions toward the UTF-8 wire budget', () => {
    const input = { ...feed(), protocolVersion: '1.1', future: '' };
    const overhead = new TextEncoder().encode(JSON.stringify(input)).length;
    input.future = 'x'.repeat(FEDERATION_LIMITS.manifestBytes - overhead);
    expect(parseFederationPublicationFeed(input).success).toBe(true);
    input.future += 'x'; expectInvalid(input);
    input.future = '😀'.repeat(16_384); expectInvalid(input);
    input.future = '\u0000'.repeat(16_384); expectInvalid(input);
    expect(parseFederationCapabilities({ ...capabilities(), protocolVersion: '1.1', extra: 'x'.repeat(65_536) }).success).toBe(false);
  });

  it('does not invoke getters, serialization hooks, or caller property reads when projecting descriptors', () => {
    let calls = 0;
    const accessor = { ...artifact() };
    Object.defineProperty(accessor, 'width', { enumerable: true, get() { calls++; return 800; } });
    expectInvalid({ ...feed(), artifacts: [accessor] });
    expectInvalid({ ...feed(), toJSON() { calls++; return feed(); } });
    const array = [artifact()];
    Object.defineProperty(array, '0', { enumerable: true, get() { calls++; return artifact(); } });
    expectInvalid({ ...feed(), artifacts: array });
    const proxy = new Proxy(artifact(), { get() { calls++; return 'synthetic-secret'; } });
    const result = parseFederationPublicationFeed({ ...feed(), artifacts: [proxy] });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(calls).toBe(0);
    const thrower = new Proxy({}, { ownKeys() { throw new Error('synthetic-secret'); } });
    expectInvalid(thrower);
  });

  it('rejects non-JSON, hostile prototypes, hidden fields, sparse arrays, cycles and excessive nesting', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let deep: unknown = {}; for (let i = 0; i < 9; i++) deep = { next: deep };
    const hidden = { ...feed() }; Object.defineProperty(hidden, 'hidden', { value: 1 });
    const symbol = { ...feed(), [Symbol('secret')]: 1 };
    const inherited = Object.assign(Object.create({ extra: true }) as Record<string, unknown>, feed());
    const forbidden = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as unknown;
    for (const extra of [cycle, deep, undefined, Infinity, NaN, BigInt(1), new Date(), new Map(), () => 1, forbidden,
      Array(1), Array.from({ length: 129 }, () => 1), Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), i])),
      Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 1))]) {
      expectInvalid({ ...feed(), protocolVersion: '1.1', extra });
    }
    for (const invalid of [hidden, symbol, inherited, null, [], 'synthetic-secret']) expectInvalid(invalid);
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, feed());
    expect(parseFederationPublicationFeed(nullPrototype).success).toBe(true);
    const shared = { safe: true };
    expect(parseFederationPublicationFeed({ ...feed(), protocolVersion: '1.1', extra: [shared, shared] }).success).toBe(true);
  });
});
