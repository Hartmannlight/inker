import { describe, expect, mock, test } from 'bun:test';
import type { Prisma, RemoteSubscription } from '@prisma/client';
import type { FederationPublicationFeed } from '@inker/contracts';
import sharp from 'sharp';
import type { PrismaService } from '../prisma/prisma.service';
import type { PublicationPersistenceService } from '../publications/publication-persistence.service';
import { canonicalJson, publicationAllowedActions, publicationArtifacts, sha256 } from '../publications/publication-content';
import { PULL_FIXTURE_ARTIFACTS } from '../device-platform/pull-fixture-artifacts';
import { RemoteImportService } from './remote-import.service';

const serverId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const fixture = PULL_FIXTURE_ARTIFACTS.find(value => value.format === 'png')!;
function feed(bytes = fixture.bytes, metadata: Partial<FederationPublicationFeed['artifacts'][number]> = {}): FederationPublicationFeed {
  const hash = sha256(bytes);
  return { protocolVersion: '1.0', serverId, publicationId: 'remote-publication', publicationRevisionId: 'remote-revision',
    revision: 1, publishedAt: '2026-08-28T12:00:00.000Z', artifacts: [{ artifactId: hash, sha256: hash,
      format: 'png', mimeType: 'image/png', width: fixture.width, height: fixture.height,
      colorSpace: fixture.colorSpace, bitDepth: fixture.bitDepth, rotation: fixture.rotation,
      sizeBytes: bytes.length, url: '/api/federation/v1/publications/remote-publication/revisions/1/artifacts/' + hash,
      ...metadata }] };
}
function setup(value = feed(), bytes = fixture.bytes) {
  const content = { schemaVersion: 2, feed: value, artifactBytes: [bytes.toString('base64')] };
  const revision = { publicationId: 'local-publication', publicationRevisionId: 'local-revision', revision: 1,
    protocolVersion: '1.0', content: content as unknown as Prisma.JsonValue, contentHash: sha256(canonicalJson(content)), createdAt: new Date(), publishedAt: new Date() };
  const subscription = { remoteServerId: 'remote-server', remotePublicationId: value.publicationId,
    localPublicationId: revision.publicationId, latestLocalRevisionId: revision.publicationRevisionId,
    remoteRevision: value.revision, remoteRevisionId: value.publicationRevisionId,
    feedHash: sha256(canonicalJson(value)) } as RemoteSubscription;
  const find = mock(async () => revision);
  const findServer = mock(async () => ({ serverId, trusted: true }));
  const findAssigned = mock(async (_args: unknown) => [{ deviceId: 2 }]);
  const append = mock(async (_input: unknown, _tx: unknown) => ({ ...revision, publicationRevisionId: 'next-local-revision', revision: 2 }));
  const assign = mock(async (_device: number, _revision: string, _tx: unknown) => ({}));
  const tx = { remoteServer: { findUniqueOrThrow: findServer }, publicationRevision: { findUnique: find },
    devicePublicationState: { findMany: findAssigned } } as unknown as Prisma.TransactionClient;
  const service = new RemoteImportService({ publicationRevision: { findUniqueOrThrow: find } } as unknown as PrismaService,
    { appendRevision: append, setDesiredRevision: assign } as unknown as PublicationPersistenceService);
  return { service, revision, subscription, tx, append, assign, find, findServer, findAssigned };
}

describe('RemoteImportService immutable cache boundary', () => {
  test('decodes every published fixture with matching dimensions, palette and precision', async () => {
    const { service } = setup();
    for (const artifact of PULL_FIXTURE_ARTIFACTS) {
      if (artifact.format !== 'png' && artifact.format !== 'bmp1') throw new Error('Unexpected fixture format');
      const value = feed(artifact.bytes, { format: artifact.format, mimeType: artifact.mimeType as 'image/png' | 'image/bmp',
        width: artifact.width, height: artifact.height, bitDepth: artifact.bitDepth, colorSpace: artifact.colorSpace, rotation: artifact.rotation });
      await service.validateArtifacts(value, [artifact.bytes]);
      expect(value.artifacts[0].sha256).toBe(artifact.sha256);
    }
  });

  test('rejects forged dimensions, truncated payloads, hash mismatches and non-images', async () => {
    const { service } = setup();
    await expect(service.validateArtifacts(feed(fixture.bytes, { width: fixture.width + 1 }), [fixture.bytes])).rejects.toThrow('REMOTE_RESPONSE_INVALID');
    await expect(service.validateArtifacts(feed(), [Buffer.from('bad')])).rejects.toThrow('REMOTE_HASH_MISMATCH');
    for (const bytes of [Buffer.from('not a PNG'), fixture.bytes.subarray(0, 20)])
      await expect(service.validateArtifacts(feed(bytes), [bytes])).rejects.toThrow('REMOTE_RESPONSE_INVALID');
    await expect(service.validateArtifacts(feed(), [])).rejects.toThrow('REMOTE_RESPONSE_INVALID');
  });

  test('pixel values must fit the advertised panel color precision', async () => {
    const { service } = setup();
    const bytes = await sharp(Buffer.from([17, 113, 201]), { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer();
    for (const metadata of [{ colorSpace: 'monochrome', bitDepth: 1 }, { colorSpace: 'grayscale', bitDepth: 8 },
      { colorSpace: 'rgb', bitDepth: 8 }, { colorSpace: 'rgb', bitDepth: 16 }] as const)
      await expect(service.validateArtifacts(feed(bytes, { width: 1, height: 1, ...metadata }), [bytes])).rejects.toThrow('REMOTE_RESPONSE_INVALID');
    await service.validateArtifacts(feed(bytes, { width: 1, height: 1, colorSpace: 'rgb', bitDepth: 24 }), [bytes]);
    const gray = await sharp(Buffer.from([85, 85, 85]), { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer();
    await service.validateArtifacts(feed(gray, { width: 1, height: 1, colorSpace: 'grayscale', bitDepth: 2 }), [gray]);
    await expect(service.validateArtifacts(feed(gray, { width: 1, height: 1, colorSpace: 'monochrome', bitDepth: 1 }), [gray])).rejects.toThrow('REMOTE_RESPONSE_INVALID');
  });

  test('cache verification binds local pointer, remote revision and canonical hash without writes', async () => {
    const h = setup();
    await h.service.verifyCached(h.subscription);
    expect(publicationArtifacts(h.revision)[0].bytes).toEqual(fixture.bytes);
    expect(publicationAllowedActions(h.revision)).toEqual([]);
    for (const change of [{ feedHash: '0'.repeat(64) }, { localPublicationId: 'wrong' }, { remoteRevision: 2 },
      { remoteRevisionId: 'wrong' }, { latestLocalRevisionId: null }])
      await expect(h.service.verifyCached({ ...h.subscription, ...change })).rejects.toThrow('REMOTE_CACHE_INVALID');
    h.revision.contentHash = '0'.repeat(64);
    await expect(h.service.verifyCached(h.subscription)).rejects.toThrow('REMOTE_CACHE_INVALID');
    expect(h.append).not.toHaveBeenCalled();
    expect(h.assign).not.toHaveBeenCalled();
  });

  test('unchanged valid content is reused; corrupt content repairs via a new immutable row', async () => {
    const h = setup();
    expect(await h.service.persist(h.tx, h.subscription, feed(), [fixture.bytes])).toEqual({ publicationRevisionId: 'local-revision', revision: 1 });
    expect(h.append).not.toHaveBeenCalled();
    h.revision.content = { invalid: true };
    expect(await h.service.persist(h.tx, h.subscription, feed(), [fixture.bytes])).toEqual({ publicationRevisionId: 'next-local-revision', revision: 2 });
    expect(h.append).toHaveBeenCalledTimes(1);
    expect(h.assign).toHaveBeenCalledWith(2, 'next-local-revision', h.tx);
    expect(h.findAssigned.mock.calls[0][0]).toMatchObject({ where: { desiredRevision: { publicationId: 'local-publication' },
      device: { isActive: true, OR: [{ playbackState: null }, { playbackState: { status: { notIn: ['running', 'paused'] } } }] } } });
  });

  test('trust, remote identity, publication scope and revision conflicts reject before appending', async () => {
    const h = setup();
    h.findServer.mockResolvedValueOnce({ serverId, trusted: false });
    await expect(h.service.persist(h.tx, h.subscription, feed(), [fixture.bytes])).rejects.toThrow('REMOTE_IDENTITY_MISMATCH');
    h.findServer.mockResolvedValueOnce({ serverId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', trusted: true });
    await expect(h.service.persist(h.tx, h.subscription, feed(), [fixture.bytes])).rejects.toThrow('REMOTE_IDENTITY_MISMATCH');
    await expect(h.service.persist(h.tx, { ...h.subscription, remotePublicationId: 'wrong' }, feed(), [fixture.bytes])).rejects.toThrow('REMOTE_PUBLICATION_MISMATCH');
    for (const change of [{ remoteRevision: 2 }, { feedHash: '0'.repeat(64) }, { remoteRevisionId: 'changed' }])
      await expect(h.service.persist(h.tx, { ...h.subscription, ...change }, feed(), [fixture.bytes])).rejects.toThrow('REMOTE_REVISION_CONFLICT');
    expect(h.append).not.toHaveBeenCalled();
  });
});
