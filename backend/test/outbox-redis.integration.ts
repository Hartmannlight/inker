import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('real Redis and two Node adapter processes recover crashes and lost subscriptions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'inker-wp16-redis-'));
  const path = join(directory, 'test.db');
    const root = resolve(__dirname, '..');
  try {
    const migration = Bun.spawn({
      cmd: [process.execPath, 'scripts/migrate-database.ts'],
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: `file:${path.replaceAll('\\', '/')}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(migration.stdout).text(),
      new Response(migration.stderr).text(),
      migration.exited,
    ]);
    expect(code, out + err).toBe(0);
    const child = Bun.spawn({
      cmd: ['node', 'test/fixtures/outbox-redis-integration.cjs', path],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Includes overlapping render/delivery crashes: two real 30s BullMQ
    // stalled-lock cycles plus the fenced SQLite lease, not a mocked clock.
    const timeout = setTimeout(() => child.kill(), 210_000);
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, out + err).toBe(0);
      console.info(out.trim());
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 230_000);
