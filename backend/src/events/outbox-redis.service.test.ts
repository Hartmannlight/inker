import { describe, expect, test } from 'bun:test';
import { OutboxRedisService } from './outbox-redis.service';
import { QUEUE_NAMES } from '../jobs/queue-policy';

describe('worker presence requires both real queue connections', () => {
  function fixture() {
    const service = new OutboxRedisService();
    const connections = new Map(QUEUE_NAMES.map(name => [name, { command: { status: 'ready' }, blocking: { status: 'ready' } }]));
    const withdrawn: string[] = [];
    let heartbeats = 0;
    const transaction = {
      zremrangebyscore: () => transaction, zadd: () => transaction, expire: () => transaction,
      exec: async () => { heartbeats++; return [[null, 1]]; },
    };
    const workers = new Map(QUEUE_NAMES.map(name => [name, { isRunning: (): boolean => true, isPaused: (): boolean => false }]));
    Object.assign(service, { workerConnections: connections, workers,
      publisher: { status: 'ready', zrem: async (_key: string, owner: string) => { withdrawn.push(owner); }, multi: () => transaction } });
    return { service, connections, workers, withdrawn, heartbeatCount: () => heartbeats };
  }
  test('does not announce running loops before both initial clients resolve', async () => {
    const f = fixture(); f.connections.clear();
    await f.service.heartbeat('initial');
    expect(f.service.workerReady()).toBe(false);
    expect(f.withdrawn).toEqual(['initial']);
    expect(f.heartbeatCount()).toBe(0);
  });
  test('withdraws presence on either disconnected client and recovers with a fresh heartbeat', async () => {
    for (const client of ['command', 'blocking'] as const) {
      const f = fixture();
      await f.service.heartbeat('worker');
      expect(f.service.workerReady()).toBe(true);
      f.connections.get('render')![client].status = 'reconnecting';
      expect(f.service.workerReady()).toBe(false);
      await f.service.heartbeat('worker');
      expect(f.withdrawn).toEqual(['worker']);
      expect(f.heartbeatCount()).toBe(1);
      f.connections.get('render')![client].status = 'ready';
      expect(f.service.workerReady()).toBe(false);
      await f.service.heartbeat('worker');
      expect(f.service.workerReady()).toBe(true);
    }
  });
  test('paused or terminated loops cannot maintain presence', async () => {
    for (const state of [{ isRunning: () => false, isPaused: () => false }, { isRunning: () => true, isPaused: () => true }]) {
      const f = fixture(); f.workers.set('render', state);
      await f.service.heartbeat('worker');
      expect(f.service.workerReady()).toBe(false);
      expect(f.heartbeatCount()).toBe(0);
    }
  });
});
