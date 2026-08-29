import { describe, expect, it } from 'bun:test';
import { Prisma } from '@prisma/client';
import { isRetryableSqliteWriteError, sqliteWrite } from './source-writes';

const busy = (code: string) => new Prisma.PrismaClientKnownRequestError('database busy', { code, clientVersion: 'test' });

describe('SQLite write serialization', () => {
  it('recognizes only the bounded contention and transaction-conflict codes', () => {
    for (const code of ['P1008', 'P2028', 'P2034']) expect(isRetryableSqliteWriteError(busy(code))).toBe(true);
    expect(isRetryableSqliteWriteError(busy('P2002'))).toBe(false);
    expect(isRetryableSqliteWriteError(new Error('database busy'))).toBe(false);
  });

  it('retries retryable failures twice and then propagates the original class', async () => {
    const client = {}, errors = ['P1008', 'P2028', 'P2034'];
    for (const code of errors) {
      let attempts = 0;
      const value = await sqliteWrite(client, async () => { attempts++; if (attempts < 3) throw busy(code); return code; });
      expect(value).toBe(code); expect(attempts).toBe(3);
    }
    let exhausted = 0;
    await expect(sqliteWrite(client, async () => { exhausted++; throw busy('P1008'); })).rejects.toMatchObject({ code: 'P1008' });
    expect(exhausted).toBe(3);
  });

  it('does not replay non-retryable work and serializes a shared Prisma client', async () => {
    const client = {}; let attempts = 0;
    await expect(sqliteWrite(client, async () => { attempts++; throw new Error('invalid'); })).rejects.toThrow('invalid');
    expect(attempts).toBe(1);
    let active = 0, maximum = 0;
    await Promise.all(Array.from({ length: 4 }, (_, index) => sqliteWrite(client, async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--; return index;
    })));
    expect(maximum).toBe(1);
  });

  it('fails bounded queue capacity with the caller domain message', async () => {
    const client = {}; let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const first = sqliteWrite(client, () => blocked);
    const pending = Array.from({ length: 1023 }, () => sqliteWrite(client, async () => undefined));
    await expect(sqliteWrite(client, async () => undefined, 'PUBLICATION_BUSY')).rejects.toMatchObject({
      status: 503, message: 'PUBLICATION_BUSY',
    });
    release(); await first; await Promise.all(pending);
  });
});
