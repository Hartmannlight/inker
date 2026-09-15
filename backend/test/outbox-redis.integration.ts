import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
      if (code !== 0) {
        const progress = join(directory, 'progress.txt');
        const { stages } = require('./foundation-diagnostics.cjs');
        const stage = existsSync(progress) ? readFileSync(progress, 'utf8') : 'start';
        if (Object.prototype.hasOwnProperty.call(stages, stage)) console.error(`FOUNDATION_DIAGNOSTIC ${stages[stage]}`);
        // A fixed fixture filename plus bounded line numbers, never exception text.
        for (const location of err.matchAll(/outbox-redis-integration\.cjs:(\d{1,5}):\d{1,5}/g))
          console.error(`FOUNDATION_FIXTURE_LINE ${location[1]}`);
      }
      expect(code, out + err).toBe(0);
      console.info(out.trim());
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 230_000);
