import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';

test('telemetry-sized write bursts cannot starve an open transaction or lose writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'inker-sqlite-pool-'));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${join(directory, 'test.db').replaceAll('\\', '/')}`;
  const p = new PrismaService();
  if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  let pending: Promise<unknown>[] = [];
  try {
    await p.onModuleInit();
    await p.$executeRawUnsafe('CREATE TABLE probe (id INTEGER PRIMARY KEY, value INTEGER)');
    await p.$executeRawUnsafe('INSERT INTO probe VALUES (1,0)');
    for (let repetition = 0; repetition < 3; repetition++) {
      const started = performance.now();
      await p.$transaction(async tx => {
        await tx.$executeRawUnsafe('UPDATE probe SET value=value+1 WHERE id=1');
        // Match the 21 WebSocket clients flushing while a domain command owns
        // the writer. Attaching then starts Prisma's otherwise lazy queries.
        pending = Array.from({ length: 21 }, () =>
          p.$executeRawUnsafe('UPDATE probe SET value=value+1 WHERE id=1').then(value => value));
        void Promise.allSettled(pending); // Observe failures immediately.
        await new Promise(resolve => setTimeout(resolve, 20));
        const row = await tx.$queryRawUnsafe<Array<{ value: number }>>('SELECT value FROM probe');
        expect(row[0].value).toBe(repetition * 22 + 1);
      });
      expect(await Promise.all(pending)).toEqual(Array(21).fill(1));
      expect(performance.now() - started).toBeLessThan(2000);
    }
    const rows = await p.$queryRawUnsafe<Array<{ value: number }>>('SELECT value FROM probe');
    expect(rows[0].value).toBe(66);
  } finally {
    await Promise.allSettled(pending);
    await p.$disconnect();
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('inker-sqlite-pool-'))
      throw new Error('Unsafe SQLite pool fixture cleanup path');
    rmSync(target, { recursive: true, force: true });
  }
}, 15000);
