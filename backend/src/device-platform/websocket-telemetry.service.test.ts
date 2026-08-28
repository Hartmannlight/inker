import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { WebSocketTelemetryService } from './websocket-telemetry.service';
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => setSystemTime());
describe('bounded telemetry buffer', () => {
  test('20 idle clients: no per-heartbeat writes; latest sample, dedupe and restart throttling', async () => {
    setSystemTime(1_000_000);
    const updateMany = mock(async (_args: { data: any }) => ({ count: 1 }));
    const service = new WebSocketTelemetryService({ device: { updateMany } } as any);
    for (let id = 1; id <= 20; id++) service.observe({ id, lastSeenAt: new Date(), telemetry: null }, 300, { width: 800, height: 480 }, true);
    for (let beat = 1; beat < 10; beat++) {
      setSystemTime(1_000_000 + beat * 30_000);
      for (let id = 1; id <= 20; id++) service.observe({ id, lastSeenAt: null, telemetry: null }, 300);
      service.flush(); await settle();
    }
    expect(updateMany).not.toHaveBeenCalled();
    setSystemTime(1_300_000); service.flush(); await settle(); expect(updateMany).toHaveBeenCalledTimes(20);
    expect(updateMany.mock.calls[0][0].data.telemetry.websocket).toEqual({ width: 800, height: 480 });
    expect(updateMany.mock.calls.every(([args]) => args.data.lastConnectedAt.getTime() === 1_000_000)).toBe(true);
    expect(updateMany.mock.calls[0][0].data.lastSeenAt.getTime()).toBe(1_300_000);
    for (let id = 1; id <= 20; id++) service.observe({ id, lastSeenAt: null, telemetry: null }, 300, { width: 800, height: 480 });
    setSystemTime(1_600_000); service.flush(); await settle();
    expect(updateMany).toHaveBeenCalledTimes(40);
    expect(updateMany.mock.calls[20][0].data.telemetry).toBeUndefined();
    expect(updateMany.mock.calls[20][0].data.lastConnectedAt).toBeUndefined();
    const restarted = new WebSocketTelemetryService({ device: { updateMany } } as any);
    restarted.observe({ id: 1, lastSeenAt: new Date(), telemetry: null }, 300); restarted.flush(); await settle();
    expect(updateMany).toHaveBeenCalledTimes(40);
    await service.onModuleDestroy(); await restarted.onModuleDestroy();
  });
  test('coalesces changed values, serializes writes, limits retries and never leaks DB errors', async () => {
    setSystemTime(1_000_000); const updateMany = mock(async (_args: { data: any }) => { throw new Error('private-credential'); });
    const service = new WebSocketTelemetryService({ device: { updateMany } } as any);
    for (let i = 0; i < 100; i++) service.observe({ id: 1, lastSeenAt: null, telemetry: null }, 60, { width: 800 + i });
    service.flush(); service.flush(); await settle(); expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].data.telemetry.websocket.width).toBe(899);
    service.flush(); await settle(); expect(updateMany).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  test('reconnect cannot bypass a failed write cooldown, and released buffers expire', async () => {
    setSystemTime(1_000_000);
    const updateMany = mock(async (_args: { data: any }) => { throw new Error('private-db-error'); });
    const service = new WebSocketTelemetryService({ device: { updateMany } } as any);
    const device = { id: 1, lastSeenAt: null, telemetry: null };
    service.observe(device, 60, { width: 800 }); service.release(1); service.flush(); await settle();
    expect(updateMany).toHaveBeenCalledTimes(1);
    service.observe(device, 60, { width: 801 }); service.flush(); await settle();
    expect(updateMany).toHaveBeenCalledTimes(1);
    service.release(1); setSystemTime(1_060_000); service.flush(); await settle();
    expect(service.metrics().bufferedDevices).toBe(0);
    await service.onModuleDestroy();
  });

  test('a partial sample after reconnect retains validated persisted fields', async () => {
    setSystemTime(1_000_000);
    const updateMany = mock(async (_args: { data: any }) => ({ count: 1 }));
    const service = new WebSocketTelemetryService({ device: { updateMany } } as any);
    service.observe({ id: 1, lastSeenAt: null, telemetry: { websocket: { width: 800, height: 480 } } }, 60, { width: 900 });
    service.flush(); await settle();
    expect(updateMany.mock.calls[0][0].data.telemetry.websocket).toEqual({ width: 900, height: 480 });
    await service.onModuleDestroy();
  });

  test('captures the connection time before asynchronous I/O and retains a newer released reconnect', async () => {
    setSystemTime(1_000_000);
    const complete: ((value: { count: number }) => void)[] = [];
    const updateMany = mock((_args: { data: any }) => new Promise<{ count: number }>(resolve => complete.push(resolve)));
    const service = new WebSocketTelemetryService({ device: { updateMany } } as any);
    const device = { id: 1, lastSeenAt: null, telemetry: null };
    service.observe(device, 60, { width: 800 }, true);
    service.flush();
    // A reconnect before the flush microtask runs must not relabel its captured sample.
    setSystemTime(1_001_000);
    service.observe(device, 60, { width: 900 }, true);
    service.release(1);
    await settle();
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ lastConnectedAt: new Date(1_000_000),
      telemetry: { websocket: { width: 800 }, updatedAt: new Date(1_000_000).toISOString() } });
    service.flush(); expect(updateMany).toHaveBeenCalledTimes(1);
    complete[0]({ count: 1 }); await settle();
    setSystemTime(1_059_999); service.flush(); await settle(); expect(updateMany).toHaveBeenCalledTimes(1);
    setSystemTime(1_060_000); service.flush(); await settle();
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany.mock.calls[1][0].data).toMatchObject({ lastConnectedAt: new Date(1_001_000),
      lastSeenAt: new Date(1_060_000), telemetry: { websocket: { width: 900 } } });
    complete[1]({ count: 1 }); await settle();
    setSystemTime(1_120_000); service.flush(); await settle();
    expect(service.metrics().bufferedDevices).toBe(0); expect(updateMany).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  test('reconnect bursts and release preserve the regular write quota and shutdown never forces a connection write', async () => {
    setSystemTime(1_000_000);
    const updateMany = mock(async (_args: { data: any }) => ({ count: 1 }));
    const service = new WebSocketTelemetryService({ device: { updateMany } } as any);
    const device = { id: 1, lastSeenAt: new Date(), telemetry: null };
    for (let i = 0; i < 100; i++) {
      setSystemTime(1_000_000 + i * 100);
      service.observe(device, 60, undefined, true); service.release(1); service.flush(); await settle();
    }
    expect(updateMany).not.toHaveBeenCalled();
    setSystemTime(1_060_000); service.flush(); await settle();
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].data).toEqual({ lastSeenAt: new Date(1_060_000), lastConnectedAt: new Date(1_009_900) });
    setSystemTime(1_070_000); service.observe(device, 60, undefined, true); service.release(1); service.flush();
    await service.onModuleDestroy();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  test('a failed or fenced update retains its connection stamp until a later throttled successful write', async () => {
    setSystemTime(1_000_000);
    let attempt = 0;
    const updateMany = mock(async (_args: { data: any }) => {
      attempt++;
      if (attempt === 2) throw new Error('private-db-error');
      return { count: attempt === 1 ? 0 : 1 };
    });
    const service = new WebSocketTelemetryService({ device: { updateMany } } as any);
    const device = { id: 1, lastSeenAt: null, telemetry: null };
    service.observe(device, 60, undefined, true);
    for (let i = 0; i < 3; i++) {
      setSystemTime(1_000_000 + i * 60_000); service.flush(); await settle();
      expect(updateMany.mock.calls[i][0].data.lastConnectedAt).toEqual(new Date(1_000_000));
      service.flush(); await settle(); expect(updateMany).toHaveBeenCalledTimes(i + 1);
    }
    setSystemTime(1_180_000); service.observe(device, 60); service.flush(); await settle();
    expect(updateMany.mock.calls[3][0].data.lastConnectedAt).toBeUndefined();
    expect(service.metrics()).toMatchObject({ writes: 2, failures: 1 });
    await service.onModuleDestroy();
  });
});
