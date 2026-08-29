import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PublicationPersistenceService } from '../src/publications/publication-persistence.service';
import { PublishService } from '../src/publications/publish.service';
import { PlaybackService } from '../src/playback/playback.service';
import { PULL_FIXTURE_ARTIFACTS } from '../src/device-platform/pull-fixture-artifacts';

const backendRoot = resolve(import.meta.dir, '..');
const migrationScript = join(backendRoot, 'scripts', 'migrate-database.ts');
const directories: string[] = [];

function databaseUrl(path: string) {
  return `file:${path.replaceAll('\\', '/')}`;
}

async function migrate(path: string) {
  const child = Bun.spawn({
    cmd: [process.execPath, migrationScript],
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl(path) },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode, stdout + stderr).toBe(0);
}

describe('UX-05 durable playlist draft publication', () => {
  let prisma: PrismaClient;
  let playback: PlaybackService;
  let uploadPath: string;

  beforeEach(async () => {
    const directory = mkdtempSync(join(tmpdir(), 'inker-ux05-playlist-'));
    directories.push(directory);
    await migrate(join(directory, 'inker.db'));
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl(join(directory, 'inker.db')) } } });
    await prisma.$connect();
    const persistence = new PublicationPersistenceService(prisma as never);
    const publisher = new PublishService(prisma as never, persistence);
    playback = new PlaybackService(prisma as never, persistence, { now: () => Date.now() } as never, publisher);
    const filename = `ux05-publish-${randomUUID()}.png`;
    const screens = join(backendRoot, 'uploads', 'screens');
    mkdirSync(screens, { recursive: true });
    uploadPath = join(screens, filename);
    writeFileSync(uploadPath, PULL_FIXTURE_ARTIFACTS.find(item => item.mimeType === 'image/png')!.bytes);
  }, 30_000);

  afterEach(async () => {
    await prisma?.$disconnect();
    try { unlinkSync(uploadPath); } catch { /* setup failed before the fixture existed */ }
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  test('replays parallel retries and never re-reads a changed draft after success', async () => {
    const screen = await prisma.screen.create({ data: { name: 'UX-05 immutable upload', imageUrl: `/uploads/screens/${uploadPath.split(/[\\/]/).pop()}` } });
    const playlist = await prisma.playlist.create({ data: { name: 'UX-05 draft', items: { create: { screenId: screen.id, order: 0, duration: 60 } } }, include: { items: true } });
    const command = { version: 1, idempotencyKey: randomUUID(), expectedDraftHash: (await playback.draft(playlist.id)).draftHash };

    const [first, second] = await Promise.all([
      playback.publishFromDraft(playlist.id, command),
      playback.publishFromDraft(playlist.id, command),
    ]) as Array<{ playlistRevisionId: string; revision: number }>;
    expect(second).toEqual(first);
    expect(await prisma.publishedPlaylist.count({ where: { playlistId: playlist.id } })).toBe(1);
    expect(await prisma.playlistDraftPublishCommand.count()).toBe(1);

    await prisma.playlistItem.update({ where: { id: playlist.items[0].id }, data: { duration: 120 } });
    expect(await playback.publishFromDraft(playlist.id, command)).toEqual(first);
    expect(await prisma.publishedPlaylist.count({ where: { playlistId: playlist.id } })).toBe(1);
  }, 30_000);
});
