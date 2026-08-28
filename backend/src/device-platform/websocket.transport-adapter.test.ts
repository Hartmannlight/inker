import { describe, expect, mock, test } from 'bun:test';
import { WebSocketTransportAdapter } from './websocket.transport-adapter';
import type { WebDisplayGateway } from './web-display.gateway';
import type { DeliveryContext } from '../events/outbox.types';

describe('WebSocket state topic routing', () => {
  test('routes timers exclusively to tiny state notifications and leaves presentation delivery intact', async () => {
    const pushTimersChanged = mock(async (_id: number, _context?: DeliveryContext) => {});
    const pushPresentation = mock(async (_id: number, _context?: DeliveryContext) => {});
    const adapter = new WebSocketTransportAdapter({ pushTimersChanged, pushPresentation } as unknown as WebDisplayGateway);
    const context = { deliveryId: 'delivery', signal: new AbortController().signal, stateTopic: 'timers' as const };
    await adapter.dispatchRefresh(7, context);
    expect(pushTimersChanged).toHaveBeenCalledWith(7, context);
    expect(pushPresentation).not.toHaveBeenCalled();
    const presentation = { deliveryId: 'other', signal: context.signal };
    await adapter.dispatchRefresh(7, presentation);
    await adapter.dispatchRefresh(8);
    expect(pushPresentation.mock.calls).toEqual([[7, presentation], [8, undefined]]);
    expect(pushTimersChanged).toHaveBeenCalledTimes(1);
  });

  test('propagates timer delivery failures to the durable retry owner', async () => {
    const pushTimersChanged = mock(async () => { throw new Error('OUTBOX_ADAPTER_FAILED'); });
    const adapter = new WebSocketTransportAdapter({ pushTimersChanged } as unknown as WebDisplayGateway);
    await expect(adapter.dispatchRefresh(7, { deliveryId: 'delivery', signal: new AbortController().signal, stateTopic: 'timers' }))
      .rejects.toThrow('OUTBOX_ADAPTER_FAILED');
  });
});
