import { describe, expect, it } from 'bun:test';
import type { PublicationRevision } from '@prisma/client';
import { BUILTIN_DEVICE_PROFILES } from '../device-platform/device-configuration.catalog';
import { canonicalJson, sha256 } from '../publications/publication-content';
import { MAX_RENDER_PIXELS, RENDERER_VERSION, renderKey, targetFor, validateRenderTarget, type RenderTarget } from './render-input';

const content = { schemaVersion: 1, fixtureArtifacts: ['mono-800x480-white-bmp'] };
const revision: PublicationRevision = { publicationId: 'publication', publicationRevisionId: 'revision-1', revision: 1,
  protocolVersion: '1.0', content, contentHash: sha256(canonicalJson(content)), publishedAt: new Date(0), createdAt: new Date(0) };
const configuration = () => ({ profile: structuredClone(BUILTIN_DEVICE_PROFILES[2].profile), capabilities: structuredClone(BUILTIN_DEVICE_PROFILES[2].defaultCapabilities) });

describe('snapshot render inputs', () => {
  it('selects the first supported capability format and strips delivery-only fields', () => {
    const config = configuration();
    config.capabilities.display.renderFormats = ['html', 'jpeg', 'png'];
    const target = targetFor(config);
    expect(target.format).toBe('jpeg');
    expect(Object.keys(target).sort()).toEqual(['bitDepth', 'colorSpace', 'format', 'height', 'profileId', 'rotation', 'safeArea', 'scaling', 'width']);
    config.capabilities.display.safeArea.left = 10;
    expect(target.safeArea.left).toBe(0);
  });

  it('selects real reference profiles including RGB565 ESP32 and monochrome BMP', () => {
    expect(BUILTIN_DEVICE_PROFILES.map(entry => targetFor({ profile: entry.profile, capabilities: entry.defaultCapabilities }).format)).toEqual(['bmp1', 'png', 'png']);
    const config = configuration();
    config.capabilities.display.bitDepth = 16;
    config.capabilities.display.renderFormats = ['jpeg', 'png'];
    expect(targetFor(config).format).toBe('png');
  });

  it('rejects mismatched MIME, unsupported precision, HTML-only and profile mismatch', () => {
    const config = configuration();
    config.capabilities.display.renderFormats = ['png'];
    config.capabilities.display.mimeTypes = ['image/bmp'];
    expect(() => targetFor(config)).toThrow('No compatible');
    config.capabilities.display.mimeTypes = ['image/png'];
    config.capabilities.display.bitDepth = 17;
    expect(() => targetFor(config)).toThrow('No compatible');
    config.capabilities.display.renderFormats = ['html'];
    expect(() => targetFor(config)).toThrow('No compatible');
    config.capabilities.profileId = 'wrong';
    expect(() => targetFor(config)).toThrow('profile mismatch');
  });

  it('gives 20 devices one render identity despite device, policy, clock and telemetry differences', () => {
    const keys = Array.from({ length: 20 }, (_, i) => {
      const config = { ...configuration(), deviceId: i, deliveryPolicy: { policyId: `policy-${i}`, pollIntervalSeconds: i + 1 } };
      config.capabilities.energy.telemetry = i % 2 ? 'minimal' : 'standard';
      config.capabilities.transport.heartbeat = i % 2 === 0;
      config.capabilities.display.eInk = { partialRefreshSupported: true, fullRefreshAfterUpdates: i + 1 };
      return renderKey({ ...revision, createdAt: new Date(i), publishedAt: new Date(i) }, targetFor(config));
    });
    expect(new Set(keys).size).toBe(1);
    const target = targetFor(configuration());
    const extended = { ...target, deviceId: 999, policyId: 'new', timestamp: Date.now(), safeArea: { ...target.safeArea, telemetry: 1 } };
    expect(renderKey(revision, extended)).toBe(renderKey(revision, target));
  });

  it('canonicalizes snapshot order and excludes unknown snapshot fields', () => {
    const target = targetFor(configuration());
    const a = { sourceId: 'a', revision: 1, contentHash: 'a'.repeat(64), connectorVersion: '1' };
    const b = { sourceId: 'b', revision: 2, contentHash: 'b'.repeat(64) };
    expect(renderKey(revision, target, [a, b])).toBe(renderKey(revision, target, [b, { ...a, createdAt: 'ignored' } as typeof a]));
    expect(() => renderKey(revision, target, [a, a])).toThrow('Duplicate');
    expect(() => renderKey(revision, target, [{ ...a, revision: 0 }])).toThrow('Invalid snapshot');
  });

  it('uses the concrete source version pinned by publication without a live source lookup', () => {
    const sourceSnapshot = { sourceId: 'source-a', snapshotId: 'snapshot-a', revision: 2, contentHash: 'b'.repeat(64), connectorVersion: 'builtin-fixture-v1' };
    const pinned = { ...revision, content: { ...content, sourceSnapshot } };
    const target = targetFor(configuration());
    expect(renderKey(pinned, target)).toBe(renderKey(pinned, target, [sourceSnapshot]));
    expect(renderKey(pinned, target)).not.toBe(renderKey(pinned, target, []));
    expect(() => renderKey({ ...pinned, content: { ...content, sourceSnapshot: { ...sourceSnapshot, revision: 0 } } }, target)).toThrow('Invalid snapshot');
  });

  it('invalidates only for publication, pixel, snapshot and renderer changes', () => {
    const target = targetFor(configuration());
    const key = renderKey(revision, target);
    for (const change of [{ publicationId: 'other' }, { publicationRevisionId: 'other' }, { revision: 2 }, { contentHash: 'c'.repeat(64) }, { protocolVersion: '1.1' }]) {
      expect(renderKey({ ...revision, ...change }, target)).not.toBe(key);
    }
    const changes: Partial<RenderTarget>[] = [{ width: 1919 }, { height: 1079 }, { profileId: 'other' }, { colorSpace: 'grayscale', bitDepth: 8 },
      { bitDepth: 16 }, { rotation: 90 }, { format: 'jpeg' }, { scaling: 'cover' }, { safeArea: { top: 1, bottom: 0, left: 0, right: 0 } }];
    for (const change of changes) expect(renderKey(revision, { ...target, ...change })).not.toBe(key);
    const snapshot = { sourceId: 'a', revision: 1, contentHash: 'a'.repeat(64), connectorVersion: '1' };
    const snapshotKey = renderKey(revision, target, [snapshot]);
    expect(snapshotKey).not.toBe(key);
    for (const change of [{ revision: 2 }, { contentHash: 'b'.repeat(64) }, { connectorVersion: '2' }]) expect(renderKey(revision, target, [{ ...snapshot, ...change }])).not.toBe(snapshotKey);
    expect(renderKey(revision, target, [], `${RENDERER_VERSION}-next`)).not.toBe(key);
  });

  it('bounds pixels and safe-area before invoking native libraries', () => {
    const target = targetFor(configuration());
    for (const change of [{ width: 0 }, { height: -1 }, { width: 1.5 }, { width: MAX_RENDER_PIXELS, height: 2 },
      { safeArea: { top: 1080, right: 0, bottom: 0, left: 0 } }, { safeArea: { top: 0, right: -1, bottom: 0, left: 0 } }]) {
      expect(() => validateRenderTarget({ ...target, ...change })).toThrow('Unsupported render target');
    }
  });
});
