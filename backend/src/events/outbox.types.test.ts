import { describe, expect, test } from 'bun:test';
import { effectKey, parseOutboxEvent, retryDelay } from './outbox.types';

describe('outbox version and secret boundary', () => {
  const event = {
    eventId: 'event-1',
    eventType: 'screen_design:updated',
    aggregateType: 'ScreenDesign',
    aggregateId: '3',
    aggregateRevision: '7',
    payloadVersion: 1,
    payload: { screenDesignId: 3, deviceIds: [2, 2], timestamp: 100 },
  };
  test('projects one logical update per aggregate revision', () => {
    expect(parseOutboxEvent(event).deviceIds).toEqual([2]);
    expect(parseOutboxEvent(event).key).toBe(
      effectKey(event.eventType, 'ScreenDesign', '3', '7'),
    );
    expect(parseOutboxEvent({ ...event, eventId: 'retry' }).key).toBe(
      parseOutboxEvent(event).key,
    );
    expect(parseOutboxEvent({ ...event, aggregateRevision: '8' }).key).not.toBe(
      parseOutboxEvent(event).key,
    );
  });
  test('rejects unknown versions, types, fields and invalid IDs without echoing input', () => {
    for (const patch of [
      { payloadVersion: 2 },
      { eventType: 'secret-value' },
      { payload: { ...event.payload, credential: 'secret-value' } },
      { payload: { ...event.payload, deviceIds: ['secret-value'] } },
      { payload: null },
      { aggregateRevision: null },
    ]) {
      expect(() => parseOutboxEvent({ ...event, ...patch })).toThrow(
        'OUTBOX_INVALID_PAYLOAD',
      );
      try {
        parseOutboxEvent({ ...event, ...patch });
      } catch (e) {
        expect(String(e)).not.toContain('secret-value');
      }
    }
  });
  test('has exponential, bounded jittered retry spacing', () => {
    expect([1, 2, 3, 4].map((n) => retryDelay(n, () => 0))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
    expect(retryDelay(100, () => 1)).toBe(72_000);
  });
  test('render-ready events authorize only explicit devices and keep cache reuse effects distinct', () => {
    const ready = { eventId: 'ready', eventType: 'render.artifact.ready', aggregateType: 'RenderRequest',
      aggregateId: 'a'.repeat(64), aggregateRevision: '10-1', payloadVersion: 1,
      payload: { renderKey: 'a'.repeat(64), deviceIds: [10, 10] } };
    expect(parseOutboxEvent(ready).deviceIds).toEqual([10]);
    expect(parseOutboxEvent({ ...ready, aggregateRevision: '11-1' }).key).not.toBe(parseOutboxEvent(ready).key);
    for (const patch of [{ payloadVersion: 2 }, { aggregateRevision: '' },
      { payload: { ...ready.payload, credential: 'synthetic-secret' } },
      { payload: { ...ready.payload, renderKey: 'b'.repeat(64) } },
      { payload: { ...ready.payload, deviceIds: ['10'] } }]) {
      expect(() => parseOutboxEvent({ ...ready, ...patch })).toThrow('OUTBOX_INVALID_PAYLOAD');
    }
  });
  test('delivers a canonical desired-publication clear to exactly its device', () => {
    const cleared = { eventId: 'clear-1', eventType: 'device.publication.desired-revision.cleared',
      aggregateType: 'DevicePublicationState', aggregateId: '9', aggregateRevision: '4', payloadVersion: 1, payload: { deviceId: 9 } };
    expect(parseOutboxEvent(cleared).deviceIds).toEqual([9]);
    expect(parseOutboxEvent({ ...cleared, aggregateRevision: '5' }).key).not.toBe(parseOutboxEvent(cleared).key);
    expect(() => parseOutboxEvent({ ...cleared, payload: { deviceId: 9, publicationRevisionId: 'secret' } })).toThrow('OUTBOX_INVALID_PAYLOAD');
  });
});
