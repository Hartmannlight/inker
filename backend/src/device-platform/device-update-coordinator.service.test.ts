import { describe, expect, it } from 'bun:test';
import { Subject } from 'rxjs';
import { createMock } from '../test/mocks/helpers';
import { DeviceUpdateCoordinator } from './device-update-coordinator.service';
import { TIMER_CHANGED } from '../timers/timer.events';
import { Prisma } from '@prisma/client';

function configured(mode: 'sleepy' | 'connected') {
  return {
    profile: { profileId: 'profile' },
    deliveryPolicy: { policyId: `policy-${mode}`, mode },
    capabilitiesOverride: null,
    capabilities: {
      transport: { modes: mode === 'connected' ? ['websocket'] : ['http-pull'] },
    },
  } as any;
}

describe('DeviceUpdateCoordinator extension dispatch', () => {
  it('expires connected clients after a retryable poll failure as required by the consumer contract', async () => {
    const expire = createMock();
    const busy = () => new Prisma.PrismaClientKnownRequestError('database busy', { code: 'P1008', clientVersion: 'test' });
    const coordinator = new DeviceUpdateCoordinator({} as any, {} as any, {} as any, {} as any,
      { list: () => [{ deliveryLeaseExpired: expire }] } as any,
      { pendingTargets: async () => { throw busy(); } } as any);
    (coordinator as any).active = true;
    (coordinator as any).leaseUntil = Date.now() + 30_000;
    (coordinator as any).renewAt = Date.now() + 5_000;
    coordinator.wake(); await (coordinator as any).running;
    expect(expire.calls).toHaveLength(1);
  });

  it('expires delivery connections immediately after a non-retryable poll failure', async () => {
    const expire = createMock();
    const coordinator = new DeviceUpdateCoordinator({} as any, {} as any, {} as any, {} as any,
      { list: () => [{ deliveryLeaseExpired: expire }] } as any,
      { pendingTargets: async () => { throw new Error('invalid-target'); } } as any);
    (coordinator as any).active = true;
    (coordinator as any).leaseUntil = Date.now() + 30_000;
    (coordinator as any).renewAt = Date.now() + 5_000;
    coordinator.wake(); await (coordinator as any).running;
    expect(expire.calls).toHaveLength(1);
  });

  it('retries a fully rolled-back target write after transient SQLite contention', async () => {
    const event = { eventId: 'event', eventType: TIMER_CHANGED, aggregateType: 'Timer', aggregateId: 'timer',
      aggregateRevision: '1', payloadVersion: 1, payload: { timerId: 'timer', version: 1, reason: 'created' } };
    let attempts = 0;
    const store = {
      pendingTargets: async () => [{ effectKey: 'effect', effect: { eventId: event.eventId, deliveries: [] } }],
      beginTarget: async () => {
        attempts++;
        if (attempts < 3) throw new Prisma.PrismaClientKnownRequestError('database busy', { code: 'P1008', clientVersion: 'test' });
        return true;
      },
      finishTarget: createMock().mockResolvedValue(true),
    };
    const coordinator = new DeviceUpdateCoordinator({ emit: createMock() } as any,
      { outboxEvent: { findUnique: async () => event } } as any, {} as any, {} as any,
      { list: () => [] } as any, store as any);
    (coordinator as any).active = true;
    (coordinator as any).leaseUntil = Date.now() + 30_000;
    (coordinator as any).renewAt = Date.now() + 5_000;
    await coordinator.poll();
    expect(attempts).toBe(3);
    expect(store.finishTarget.calls).toHaveLength(1);
  });

  it('renews the 15-second consumer lease inside a long fan-out poll', async () => {
    const originalNow = Date.now; let now = 1_000;
    Date.now = () => now;
    try {
      const timerId = '14899899-30ab-451d-87fa-14a001eb9748';
      const event = { eventId: 'event', eventType: TIMER_CHANGED, aggregateType: 'Timer', aggregateId: timerId,
        aggregateRevision: '1', payloadVersion: 1, payload: { timerId, version: 1, reason: 'created' } };
      const register = createMock().mockResolvedValue(undefined), finishTarget = createMock().mockResolvedValue(true);
      const dispatchRefresh = createMock().mockImplementation(async () => { now += 6_000; });
      const store = { register,
        pendingTargets: async () => [{ effectKey: 'effect', effect: { eventId: event.eventId,
          deliveries: [{ deviceId: 1, deliveryId: 'one' }, { deviceId: 2, deliveryId: 'two' }] } }],
        beginTarget: async () => true, finishTarget };
      const coordinator = new DeviceUpdateCoordinator({ emit: createMock() } as any,
        { outboxEvent: { findUnique: async () => event }, device: { findMany: async ({ where }: any) => [{ id: where.id.in[0] }] } } as any,
        { resolvePersisted: () => configured('connected') } as any,
        { get: () => ({ dispatchOnRefresh: true, selectTransport: () => 'websocket' }) } as any,
        { list: () => [], get: () => ({ dispatchRefresh }) } as any, store as any);
      (coordinator as any).active = true;
      (coordinator as any).leaseUntil = 16_000;
      (coordinator as any).renewAt = 6_000;
      await coordinator.poll();
      expect(dispatchRefresh.calls).toHaveLength(2);
      expect(register.calls).toHaveLength(2);
      expect((coordinator as any).leaseUntil).toBe(28_000);
    } finally { Date.now = originalNow; }
  });

  it('uses the persisted registration timestamp for the local lease fence', async () => {
    const originalNow = Date.now; let now = 1_000, persistedAt: Date | undefined;
    Date.now = () => now;
    try {
      const store = { register: async (_id: string, at: Date) => { persistedAt = at; now = 4_000; } };
      const coordinator = new DeviceUpdateCoordinator({} as any, {} as any, {} as any, {} as any,
        { list: () => [] } as any, store as any);
      await (coordinator as any).registerLease();
      expect(persistedAt?.getTime()).toBe(1_000);
      expect((coordinator as any).renewAt).toBe(6_000);
      expect((coordinator as any).leaseUntil).toBe(16_000);
    } finally { Date.now = originalNow; }
  });

  it('propagates renewal failure before fan-out without misclassifying the target', async () => {
    const event = { eventId: 'event' };
    const dispatchRefresh = createMock(), finishTarget = createMock();
    const coordinator = new DeviceUpdateCoordinator({} as any,
      { outboxEvent: { findUnique: async () => event } } as any, {} as any, {} as any,
      { list: () => [], get: () => ({ dispatchRefresh }) } as any,
      { register: async () => { throw new Error('renew-failed'); }, pendingTargets: async () => [{ effectKey: 'effect', effect: {
        eventId: event.eventId, deliveries: [{ deviceId: 1, deliveryId: 'one' }] } }], beginTarget: async () => true, finishTarget } as any);
    (coordinator as any).active = true; (coordinator as any).leaseUntil = Date.now() + 15_000; (coordinator as any).renewAt = 0;
    await expect(coordinator.poll()).rejects.toThrow('renew-failed');
    expect(dispatchRefresh.calls).toHaveLength(0); expect(finishTarget.calls).toHaveLength(0);
  });

  it('propagates renewal failure after a successful send without recording adapter failure', async () => {
    const originalNow = Date.now; let now = 1_000, registrations = 0;
    Date.now = () => now;
    try {
      const timerId = '14899899-30ab-451d-87fa-14a001eb9748';
      const event = { eventId: 'event', eventType: TIMER_CHANGED, aggregateType: 'Timer', aggregateId: timerId,
        aggregateRevision: '1', payloadVersion: 1, payload: { timerId, version: 1, reason: 'created' } };
      const dispatchRefresh = createMock().mockImplementation(async () => { now = 7_000; });
      const finishTarget = createMock();
      const store = { register: async () => { registrations++; throw new Error('renew-failed'); },
        pendingTargets: async () => [{ effectKey: 'effect', effect: { eventId: event.eventId,
          deliveries: [{ deviceId: 1, deliveryId: 'one' }] } }], beginTarget: async () => true, finishTarget };
      const coordinator = new DeviceUpdateCoordinator({ emit: createMock() } as any,
        { outboxEvent: { findUnique: async () => event }, device: { findMany: async () => [{ id: 1 }] } } as any,
        { resolvePersisted: () => configured('connected') } as any,
        { get: () => ({ dispatchOnRefresh: true, selectTransport: () => 'websocket' }) } as any,
        { list: () => [], get: () => ({ dispatchRefresh }) } as any, store as any);
      (coordinator as any).active = true; (coordinator as any).leaseUntil = 16_000; (coordinator as any).renewAt = 6_000;
      await expect(coordinator.poll()).rejects.toThrow('renew-failed');
      expect(dispatchRefresh.calls).toHaveLength(1); expect(registrations).toBe(1); expect(finishTarget.calls).toHaveLength(0);
    } finally { Date.now = originalNow; }
  });

  it('routes durable timer targets with stateTopic and rechecks active devices', async () => {
    const timerId = '14899899-30ab-451d-87fa-14a001eb9748';
    const event = { eventId: 'timer-event', eventType: TIMER_CHANGED, aggregateType: 'Timer', aggregateId: timerId,
      aggregateRevision: '1', payloadVersion: 1, payload: { timerId, version: 1, reason: 'created' } };
    const findMany = createMock().mockResolvedValue([{ id: 7 }]);
    const dispatchRefresh = createMock().mockResolvedValue(undefined), emit = createMock();
    const finishTarget = createMock().mockResolvedValue(true);
    const store = { register: createMock().mockResolvedValue(undefined),
      pendingTargets: async () => [{ effectKey: 'effect', effect: { eventId: event.eventId, deliveries: [{ deviceId: 7, deliveryId: 'delivery' }] } }],
      beginTarget: async () => true, finishTarget };
    const coordinator = new DeviceUpdateCoordinator({ emit } as any,
      { device: { findMany }, outboxEvent: { findUnique: async () => event } } as any,
      { resolvePersisted: () => configured('connected') } as any,
      { get: () => ({ dispatchOnRefresh: true, selectTransport: () => 'websocket' }) } as any,
      { list: () => [], get: () => ({ dispatchRefresh }) } as any, store as any);
    (coordinator as any).active = true;
    await coordinator.poll();
    expect(findMany.calls[0][0]).toMatchObject({ where: { id: { in: [7] }, isActive: true } });
    expect(dispatchRefresh.calls).toHaveLength(1);
    expect(dispatchRefresh.calls[0][0]).toBe(7);
    expect(dispatchRefresh.calls[0][1]).toMatchObject({ deliveryId: 'delivery', stateTopic: 'timers' });
    expect(dispatchRefresh.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(finishTarget.calls[0][3]).toBe(true);
    expect(emit.calls).toHaveLength(0);
  });

  it('dispatches connected devices through the selected adapter and leaves pull devices pending', async () => {
    const stream = new Subject<any>();
    const prisma = {
      device: {
        findMany: createMock().mockResolvedValue([
          { id: 1, profile: {}, deliveryPolicy: { mode: 'connected' }, capabilitiesOverride: null },
          { id: 2, profile: {}, deliveryPolicy: { mode: 'sleepy' }, capabilitiesOverride: null },
        ]),
      },
    };
    const dispatchRefresh = createMock().mockResolvedValue(undefined);
    const coordinator = new DeviceUpdateCoordinator(
      { getEventStream: () => stream } as any,
      prisma as any,
      { resolvePersisted: (device: any) => configured(device.deliveryPolicy.mode) } as any,
      {
        get: (mode: string) => ({
          dispatchOnRefresh: mode === 'connected',
          selectTransport: () => mode === 'connected' ? 'websocket' : 'http-pull',
        }),
      } as any,
      { get: () => ({ dispatchRefresh }) } as any,
      {} as any,
    );

    await coordinator.refreshDevices([1, 2]);

    expect(dispatchRefresh.calls).toEqual([[1]]);
  });

  it('does not subscribe to transient SSE events for device delivery', () => {
    const stream = new Subject<any>();
    const findMany = createMock().mockResolvedValue([]);
    new DeviceUpdateCoordinator({ getEventStream: () => stream } as any,
      { device: { findMany } } as any, {} as any, {} as any, {} as any, {} as any);
    stream.next({ payload: { deviceIds: [4, 7] } });
    expect(findMany.calls).toHaveLength(0);
  });

  it('propagates adapter failures to the durable retry owner', async () => {
    const coordinator = new DeviceUpdateCoordinator({} as any,
      { device: { findMany: async () => [{ id: 1 }] } } as any,
      { resolvePersisted: () => configured('connected') } as any,
      { get: () => ({ dispatchOnRefresh: true, selectTransport: () => 'dummy' }) } as any,
      { get: () => ({ dispatchRefresh: async () => { throw new Error('transport-error'); } }) } as any, {} as any);
    await expect(coordinator.refreshDevices([1])).rejects.toThrow('transport-error');
  });
});
