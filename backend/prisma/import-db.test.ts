import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { importSnapshot } from './import-db';
import { EXPORT_FILENAME } from './db-snapshot';

function writeSnapshotFile(dir: string, tables: Record<string, any[]>) {
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(tables)) counts[k] = v.length;
  fs.writeFileSync(
    path.join(dir, EXPORT_FILENAME),
    JSON.stringify({ version: 1, exportedAt: '2026-01-01T00:00:00.000Z', counts, tables }),
  );
}

/** Build a mock transaction client whose count() reflects what createMany() inserted. */
function makeTx(opts: { brokenCount?: boolean } = {}) {
  const stored: Record<string, number> = {};
  const createOrder: string[] = [];
  const seqSql: string[] = [];
  const base: any = {
    $executeRawUnsafe: async (sql: string) => {
      seqSql.push(sql);
      return 0;
    },
  };
  const tx: any = new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return {
        createMany: async ({ data }: any) => {
          stored[prop] = data.length;
          createOrder.push(prop);
          return { count: data.length };
        },
        count: async () => (opts.brokenCount ? -1 : stored[prop] ?? 0),
      };
    },
  });
  return { tx, stored, createOrder, seqSql };
}

describe('importSnapshot', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inker-import-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws when the snapshot file is missing', async () => {
    const { tx } = makeTx();
    const prisma: any = { $transaction: async (fn: any) => fn(tx) };
    await expect(importSnapshot(prisma, dir)).rejects.toThrow(/not found/i);
  });

  it('imports only non-empty tables in FK-safe order and resets sequences', async () => {
    writeSnapshotFile(dir, {
      Model: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
      Device: [{ id: 5, name: 'd' }],
      PlaylistItem: [{ id: 9 }],
    });
    const { tx, createOrder, seqSql } = makeTx();
    const prisma: any = { $transaction: async (fn: any) => fn(tx) };

    const res = await importSnapshot(prisma, dir);

    expect(res.total).toBe(4);
    // Parents before children: Model -> Device -> PlaylistItem (delegate names).
    expect(createOrder).toEqual(['model', 'device', 'playlistItem']);
    // Each non-empty table emits a DELETE + INSERT into sqlite_sequence (3 tables -> 6).
    expect(seqSql.length).toBe(6);
    expect(seqSql.some((s) => s.includes('sqlite_sequence'))).toBe(true);
  });

  it('throws on a row-count mismatch so the transaction rolls back', async () => {
    writeSnapshotFile(dir, { Model: [{ id: 1, name: 'a' }] });
    const { tx } = makeTx({ brokenCount: true });
    const prisma: any = { $transaction: async (fn: any) => fn(tx) };
    await expect(importSnapshot(prisma, dir)).rejects.toThrow(/mismatch/i);
  });
});
