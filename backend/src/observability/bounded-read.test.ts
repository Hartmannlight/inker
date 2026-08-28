import { describe, expect, test } from 'bun:test';
import { BoundedRead, readBatch } from './bounded-read';

describe('bounded diagnostic reads', () => {
  test('times out, aborts subsequent batches and keeps one slot until the outstanding query settles', async () => {
    const read = new BoundedRead();
    let release!: () => void, signal!: AbortSignal, laterBatches = 0;
    const outstanding = new Promise<void>(resolve => { release = resolve; });
    const first = read.run(async current => {
      signal = current;
      await outstanding;
      current.throwIfAborted();
      laterBatches++;
      return 1;
    }, 10);
    await expect(first).rejects.toThrow('OBSERVABILITY_READ_TIMEOUT');
    expect(signal.aborted).toBe(true);
    for (let i = 0; i < 20; i++) await expect(read.run(async () => 2, 10)).rejects.toThrow('OBSERVABILITY_READ_BUSY');
    release();
    await outstanding;
    await Promise.resolve();
    await Promise.resolve();
    expect(laterBatches).toBe(0);
    expect(await read.run(async () => 3, 10)).toBe(3);
  });

  test('releases failed and successful reads without stale timeouts affecting the next request', async () => {
    const read = new BoundedRead();
    await expect(read.run(async () => { throw new Error('fixture'); }, 10)).rejects.toThrow('fixture');
    expect(await read.run(async signal => { expect(signal.aborted).toBe(false); return 4; }, 10)).toBe(4);
    expect(await read.run(async signal => {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(signal.aborted).toBe(false);
      return 5;
    }, 100)).toBe(5);
  });

  test('drains sibling queries on an early batch rejection before releasing the scan slot', async () => {
    const read = new BoundedRead();
    let release!: () => void;
    const delayed = new Promise<number>(resolve => { release = () => resolve(2); });
    await expect(read.run(() => readBatch([Promise.reject(new Error('early')), delayed] as const), 10))
      .rejects.toThrow('OBSERVABILITY_READ_TIMEOUT');
    await expect(read.run(async () => 3, 10)).rejects.toThrow('OBSERVABILITY_READ_BUSY');
    release();
    await delayed;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(await read.run(() => readBatch([Promise.resolve(4), Promise.resolve('ready')] as const), 10)).toEqual([4, 'ready']);
  });
});
