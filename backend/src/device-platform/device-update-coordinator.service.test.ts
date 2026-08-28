import { describe, expect, it } from 'bun:test';
import { Subject } from 'rxjs';
import { createMock } from '../test/mocks/helpers';
import { DeviceUpdateCoordinator } from './device-update-coordinator.service';
import { TIMER_CHANGED } from '../timers/timer.events';

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
