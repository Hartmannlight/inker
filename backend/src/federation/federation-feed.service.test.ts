import { describe, expect, mock, test } from 'bun:test';
import type { PublicationRevision } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { canonicalJson, sha256 } from '../publications/publication-content';
import { PULL_FIXTURE_ARTIFACTS } from '../device-platform/pull-fixture-artifacts';
import { FederationFeedService } from './federation-feed.service';
import type { FederationIdentityService } from './federation-identity.service';

const SERVER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PNG = PULL_FIXTURE_ARTIFACTS.find(artifact => artifact.format === 'png')!;

function revision(overrides: Partial<PublicationRevision> = {}): PublicationRevision {
  const content = {
    schemaVersion: 1, fixtureArtifacts: [PNG.fixtureId],
    sourceSnapshot: { sourceId: 'private-source', snapshotId: 'private-snapshot', credential: 'secret-value' },
    allowedActions: [{ action: 'view.next', payloadSchemaVersion: '1.0' }],
    timerState: { timerId: 'private-timer' }, draft: 'private-draft',
  };
  return {
    publicationId: 'publication-one', publicationRevisionId: 'revision-one', revision: 1,
    content, contentHash: sha256(canonicalJson(content)), protocolVersion: '1.0',
    publishedAt: new Date('2026-08-28T12:00:00.000Z'), createdAt: new Date('2026-08-28T12:00:00.000Z'),
    ...overrides,
  };
}

function setup(row: PublicationRevision | null = revision()) {
  const findFirst = mock(async (_args: unknown) => row);
  const findUnique = mock(async (_args: unknown) => row);
  const serverId = mock(async () => SERVER_ID);
  const service = new FederationFeedService(
    { publicationRevision: { findFirst, findUnique } } as unknown as PrismaService,
    { serverId } as unknown as FederationIdentityService,
  );
  return { service, findFirst, findUnique, serverId };
}

describe('FederationFeedService', () => {
  test('stable discovery advertises only the bounded read-only protocol', async () => {
    const { service, findFirst, findUnique } = setup();
    const first = await service.capabilities();
    expect(first).toEqual(await service.capabilities());
    expect(first.body).toEqual({
      protocolVersion: '1.0', serverId: SERVER_ID, readOnly: true,
      features: ['publication-feed', 'immutable-artifacts'],
      limits: { manifestBytes: 65536, artifactBytes: 2097152, artifacts: 8 },
    });
    expect(first.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(findFirst).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  test('reads latest published revision and projects no local payload or credentials', async () => {
    const { service, findFirst, findUnique } = setup();
    const result = await service.read('publication-one');
    expect(findFirst).toHaveBeenCalledWith({ where: { publicationId: 'publication-one' }, orderBy: { revision: 'desc' } });
    expect(findUnique).not.toHaveBeenCalled();
    expect(Object.keys(result.body).sort()).toEqual([
      'artifacts', 'protocolVersion', 'publicationId', 'publicationRevisionId', 'publishedAt', 'revision', 'serverId',
    ]);
    expect(result.body.artifacts).toEqual([{
      artifactId: PNG.sha256, sha256: PNG.sha256, mimeType: 'image/png', format: 'png',
      width: PNG.width, height: PNG.height, colorSpace: PNG.colorSpace,
      bitDepth: PNG.bitDepth, rotation: PNG.rotation, sizeBytes: PNG.bytes.length,
      url: '/api/federation/v1/publications/publication-one/revisions/1/artifacts/' + PNG.sha256,
    }]);
    const serialized = JSON.stringify(result);
    for (const forbidden of ['secret-value', 'private-source', 'private-snapshot', 'private-timer', 'private-draft', 'allowedActions', 'view.next', 'fixtureArtifacts', 'contentHash']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(result.etag).toBe('"' + sha256(canonicalJson(result.body)) + '"');
    expect((await service.read('publication-one')).etag).toBe(result.etag);
  });

  test('identity and revision changes invalidate feed ETags', async () => {
    const { service, serverId, findFirst } = setup();
    const first = await service.read('publication-one');
    serverId.mockResolvedValue('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
    const second = await service.read('publication-one');
    expect(second.etag).not.toBe(first.etag);
    findFirst.mockResolvedValue(revision({ revision: 2, publicationRevisionId: 'revision-two' }));
    expect((await service.read('publication-one')).etag).not.toBe(second.etag);
  });

  test('image snapshots use only the persisted bytes', async () => {
    const content = { schemaVersion: 1, image: {
      png: PNG.bytes.toString('base64'), sha256: PNG.sha256, width: 800, height: 480,
    }, sourceSnapshot: { sourceId: 'no-provider-fetch' } };
    const { service } = setup(revision({ content, contentHash: sha256(canonicalJson(content)) }));
    const feed = await service.read('publication-one');
    expect(feed.body.artifacts[0].sha256).toBe(PNG.sha256);
    expect((await service.artifact('publication-one', '1', PNG.sha256)).bytes).toEqual(PNG.bytes);
  });

  test('old retained artifacts are publication scoped and buffers are detached', async () => {
    const { service, findFirst, findUnique } = setup();
    const first = await service.artifact('publication-one', '1', PNG.sha256);
    expect(findUnique).toHaveBeenCalledWith({ where: { publicationId_revision: { publicationId: 'publication-one', revision: 1 } } });
    expect(findFirst).not.toHaveBeenCalled();
    expect(first.etag).toBe('"' + PNG.sha256 + '"');
    expect(first.mimeType).toBe('image/png');
    expect(first.bytes).not.toBe(PNG.bytes);
    first.bytes[0] = 0;
    expect((await service.artifact('publication-one', '1', PNG.sha256)).bytes[0]).toBe(137);
    findUnique.mockResolvedValue(null);
    await expect(service.artifact('publication-two', '1', PNG.sha256)).rejects.toThrow('FEDERATION_ARTIFACT_NOT_FOUND');
    expect(findUnique).toHaveBeenLastCalledWith({ where: { publicationId_revision: { publicationId: 'publication-two', revision: 1 } } });
  });

  test('unknown publications and hashes return bounded not-found errors', async () => {
    await expect(setup(null).service.read('publication-one')).rejects.toThrow('FEDERATION_PUBLICATION_NOT_FOUND');
    await expect(setup().service.artifact('publication-one', '1', '0'.repeat(64))).rejects.toThrow('FEDERATION_ARTIFACT_NOT_FOUND');
  });

  test.each(['', '../publication', 'with_underscore', 'a'.repeat(101)])('invalid publication identifier %s never queries', async id => {
    const { service, findFirst, findUnique } = setup();
    await expect(service.read(id)).rejects.toThrow('FEDERATION_PUBLICATION_NOT_FOUND');
    await expect(service.artifact(id, '1', PNG.sha256)).rejects.toThrow('FEDERATION_PUBLICATION_NOT_FOUND');
    expect(findFirst).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  test.each(['0', '-1', '01', '1e2', '1.5', '2147483648', '1/2'])('invalid revision %s never queries', async value => {
    const { service, findUnique } = setup();
    await expect(service.artifact('publication-one', value, PNG.sha256)).rejects.toThrow('FEDERATION_ARTIFACT_NOT_FOUND');
    expect(findUnique).not.toHaveBeenCalled();
  });

  test.each(['', 'A'.repeat(64), '../', '0'.repeat(65)])('invalid hash %s never queries', async hash => {
    const { service, findUnique } = setup();
    await expect(service.artifact('publication-one', '1', hash)).rejects.toThrow('FEDERATION_ARTIFACT_NOT_FOUND');
    expect(findUnique).not.toHaveBeenCalled();
  });

  test('hash corruption fails closed for both feed and direct artifact', async () => {
    const { service } = setup(revision({ contentHash: '0'.repeat(64) }));
    await expect(service.read('publication-one')).rejects.toThrow('FEDERATION_PUBLICATION_UNAVAILABLE');
    await expect(service.artifact('publication-one', '1', PNG.sha256)).rejects.toThrow('FEDERATION_PUBLICATION_UNAVAILABLE');
  });

  test('legacy fixtures also require their actual immutable content hash', async () => {
    const content = { fixtureArtifacts: [PNG.fixtureId] };
    const { service, findFirst } = setup(revision({ content, contentHash: 'legacy-unverified' }));
    await expect(service.read('publication-one')).rejects.toThrow('FEDERATION_PUBLICATION_UNAVAILABLE');
    findFirst.mockResolvedValue(revision({ content, contentHash: sha256(canonicalJson(content)) }));
    expect((await service.read('publication-one')).body.artifacts).toHaveLength(1);
  });

  test.each([0, 8193, 100_000])('invalid image dimension %s fails closed on both routes', async width => {
    const content = { schemaVersion: 1, image: { png: PNG.bytes.toString('base64'), sha256: PNG.sha256, width, height: 480 } };
    const { service } = setup(revision({ content, contentHash: sha256(canonicalJson(content)) }));
    await expect(service.read('publication-one')).rejects.toThrow('FEDERATION_PUBLICATION_UNAVAILABLE');
    await expect(service.artifact('publication-one', '1', PNG.sha256)).rejects.toThrow('FEDERATION_PUBLICATION_UNAVAILABLE');
  });

  test('incompatible stored protocol and invalid publication dates cannot escape', async () => {
    for (const row of [revision({ protocolVersion: '2.0' }), revision({ publishedAt: new Date(NaN) })]) {
      await expect(setup(row).service.read('publication-one')).rejects.toThrow('FEDERATION_PUBLICATION_UNAVAILABLE');
    }
  });

  test('oversized image bytes and invalid image checksums cannot be served directly', async () => {
    const oversized = Buffer.alloc(2097153);
    for (const image of [
      { png: oversized.toString('base64'), sha256: sha256(oversized), width: 800, height: 480 },
      { png: PNG.bytes.toString('base64'), sha256: '0'.repeat(64), width: 800, height: 480 },
      { png: PNG.bytes.toString('base64'), sha256: PNG.sha256, width: 8192, height: 8192 },
    ]) {
      const content = { schemaVersion: 1, image };
      const { service } = setup(revision({ content, contentHash: sha256(canonicalJson(content)) }));
      await expect(service.read('publication-one')).rejects.toThrow('FEDERATION_PUBLICATION_UNAVAILABLE');
      await expect(service.artifact('publication-one', '1', image.sha256)).rejects.toThrow('FEDERATION_PUBLICATION_UNAVAILABLE');
    }
  });

  test('database and identity failures expose only the fixed unavailable error', async () => {
    const { service, findFirst, findUnique, serverId } = setup();
    const privateError = new Error('SQL database path /private/secret-value');
    findFirst.mockRejectedValue(privateError);
    findUnique.mockRejectedValue(privateError);
    serverId.mockRejectedValue(privateError);
    for (const operation of [
      () => service.read('publication-one'),
      () => service.artifact('publication-one', '1', PNG.sha256),
      () => service.capabilities(),
    ]) {
      try {
        await operation();
        throw new Error('Expected failure');
      } catch (error) {
        expect((error as Error).message).toBe('FEDERATION_PUBLICATION_UNAVAILABLE');
        expect((error as Error).stack).not.toContain('secret-value');
      }
    }
  });
});
