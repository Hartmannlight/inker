import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

describe('SQLite / Nest discovery / Node WebSocket integration', () => {
  let directory: string;
  let path: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-wp15-'));
    path = join(directory, 'test.db');
    const migration = spawn({ cmd: [process.execPath, 'scripts/migrate-database.ts'], cwd: root,
      env: { ...process.env, DATABASE_URL: `file:${path.replaceAll('\\', '/')}` }, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(migration.stdout).text(), new Response(migration.stderr).text(), migration.exited]);
    expect(code, out + err).toBe(0);
  }, 30_000);
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  for (const scenario of ['idle', 'rotation', 'auth', 'limits']) {
    test(scenario, async () => {
      // Node hosts both ws and the HTTP listener. Bun's HTTP close callback hangs
      // after native ws upgrades, even when all sockets and listeners are gone.
      const child = spawn({ cmd: ['node', 'test/fixtures/websocket-integration.cjs', scenario, path], cwd: root,
        stdout: 'pipe', stderr: 'pipe' });
      const timeout = setTimeout(() => child.kill(), 25_000);
      try {
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code, out + err).toBe(0);
        expect(out).toContain(`WP-15 ${scenario}: passed`);
      } finally { clearTimeout(timeout); }
    }, 30_000);
  }
});
