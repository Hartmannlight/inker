import { describe, expect, it } from 'bun:test';
import { Subject } from 'rxjs';
import { createMock } from '../test/mocks/helpers';
import { DeviceUpdateCoordinator } from './device-update-coordinator.service';

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
