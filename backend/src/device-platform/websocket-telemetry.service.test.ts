import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { WebSocketTelemetryService } from './websocket-telemetry.service';
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => setSystemTime());
describe('bounded telemetry buffer', () => {
  test('20 idle clients: no per-heartbeat writes; latest sample, dedupe and restart throttling', async () => {
    setSystemTime(1_000_000);
    const updateMany = mock(async (_args: { data: any }) => ({ count: 1 }));
    const service = new WebSocketTelemetryService({ device: { updateMany } } as any);
    for (let id = 1; id <= 20; id++) service.observe({ id, lastSeenAt: new Date(), telemetry: null }, 300, { width: 800, height: 480 });
    for (let beat = 1; beat < 10; beat++) {
      setSystemTime(1_000_000 + beat * 30_000);
      for (let id = 1; id <= 20; id++) service.observe({ id, lastSeenAt: null, telemetry: null }, 300);
      service.flush(); await settle();
    }
    expect(updateMany).not.toHaveBeenCalled();
    setSystemTime(1_300_000); service.flush(); await settle(); expect(updateMany).toHaveBeenCalledTimes(20);
    expect(updateMany.mock.calls[0][0].data.telemetry.websocket).toEqual({ width: 800, height: 480 });
    for (let id = 1; id <= 20; id++) service.observe({ id, lastSeenAt: null, telemetry: null }, 300, { width: 800, height: 480 });
    setSystemTime(1_600_000); service.flush(); await settle();
    expect(updateMany).toHaveBeenCalledTimes(40);
    expect(updateMany.mock.calls[20][0].data.telemetry).toBeUndefined();
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
});
