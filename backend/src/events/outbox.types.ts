import { createHash } from 'node:crypto';
import type { DeviceEvent } from './events.service';
import { PUBLICATION_EVENT_TYPES as PUB } from '../publications/publication-persistence.types';
import { parsePlaybackEvent, PLAYBACK_CHANGED } from '../playback/playback.events';

export { OUTBOX_POLICY, retryDelay } from '../jobs/queue-policy';

export function effectKey(
  type: string,
  aggregate: string,
  id: string,
  revision: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([type, aggregate, id, revision]))
    .digest('hex');
}

export interface EventInput {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateRevision?: string | null;
  payloadVersion: number;
  payload: unknown;
}

const legacy = new Map<string, [string, string | undefined]>([
  ['screen:updated', ['Screen', 'screenId']],
  ['screen:deleted', ['Screen', 'screenId']],
  ['playlist:updated', ['Playlist', 'playlistId']],
  ['playlist:deleted', ['Playlist', 'playlistId']],
  ['screen_design:updated', ['ScreenDesign', 'screenDesignId']],
  ['screen_design:deleted', ['ScreenDesign', 'screenDesignId']],
  ['device:refresh', ['Device', undefined]],
]);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

/** Strict allowlist: neither producer payloads nor untrusted diagnostics are forwarded. */
export function parseOutboxEvent(event: EventInput): {
  key: string;
  deviceIds: number[];
  notification?: DeviceEvent;
} {
  const invalid = () => {
    throw new Error('OUTBOX_INVALID_PAYLOAD');
  };
  if (
    event.payloadVersion !== 1 ||
    !event.payload ||
    typeof event.payload !== 'object' ||
    Array.isArray(event.payload)
  )
    return invalid();
  const p = event.payload as Record<string, unknown>;
  if (event.eventType === 'render.artifact.ready') {
    if (event.aggregateType !== 'RenderRequest' || !event.aggregateRevision || !/^[a-zA-Z0-9-]{1,100}$/.test(event.aggregateRevision) ||
      !/^[a-f0-9]{64}$/.test(event.aggregateId) || p.renderKey !== event.aggregateId ||
      Object.keys(p).sort().join(',') !== 'deviceIds,renderKey' || !Array.isArray(p.deviceIds) || !p.deviceIds.every(positive)) return invalid();
    return { key: effectKey(event.eventType, event.aggregateType, event.aggregateId, event.aggregateRevision), deviceIds: [...new Set(p.deviceIds as number[])] };
  }
  if (event.eventType === PLAYBACK_CHANGED) {
    parsePlaybackEvent(event);
    return { key: effectKey(event.eventType, event.aggregateType, event.aggregateId, event.aggregateRevision!), deviceIds: [] };
  }
  const shape = legacy.get(event.eventType);
  if (shape) {
    const [aggregate, idField] = shape;
    if (
      event.aggregateType !== aggregate ||
      !event.aggregateRevision ||
      !/^\d+$/.test(event.aggregateRevision) ||
      !Array.isArray(p.deviceIds) ||
      !p.deviceIds.every(positive) ||
      !Number.isSafeInteger(p.timestamp) ||
      Number(p.timestamp) < 0 ||
      Object.keys(p).some(
        (k) =>
          !['deviceIds', 'timestamp', ...(idField ? [idField] : [])].includes(
            k,
          ),
      ) ||
      (idField &&
        (!positive(p[idField]) || String(p[idField]) !== event.aggregateId))
    )
      return invalid();
    const deviceIds = [...new Set(p.deviceIds as number[])];
    return {
      key: effectKey(
        event.eventType,
        aggregate,
        event.aggregateId,
        event.aggregateRevision,
      ),
      deviceIds,
      notification: {
        type: event.eventType as DeviceEvent['type'],
        payload: { ...p, deviceIds } as DeviceEvent['payload'],
      },
    };
  }
  if (
    !Object.values(PUB).includes(
      event.eventType as (typeof PUB)[keyof typeof PUB],
    )
  )
    return invalid();
  const created = event.eventType === PUB.revisionCreated;
  const assigned = event.eventType === PUB.desiredRevisionChanged;
  if (assigned && event.aggregateRevision != null && !/^[1-9]\d*$/.test(event.aggregateRevision)) return invalid();
  const allowed = [
    'publicationId',
    'publicationRevisionId',
    'revision',
    ...(created
      ? ['publicationKey', 'protocolVersion', 'contentHash']
      : ['deviceId']),
  ];
  if (
    Object.keys(p).some((k) => !allowed.includes(k)) ||
    !positive(p.revision) ||
    typeof p.publicationId !== 'string' ||
    !p.publicationId ||
    typeof p.publicationRevisionId !== 'string' ||
    !p.publicationRevisionId ||
    (!created &&
      (!positive(p.deviceId) || event.aggregateId !== String(p.deviceId))) ||
    event.aggregateType !==
      (created ? 'PublicationRevision' : 'DevicePublicationState') ||
    (created &&
      (event.aggregateId !== p.publicationRevisionId ||
        ['publicationKey', 'protocolVersion', 'contentHash'].some(
          (k) => typeof p[k] !== 'string',
        )))
  )
    return invalid();
  return {
    key: effectKey(
      event.eventType,
      event.aggregateType,
      event.aggregateId,
      assigned && event.aggregateRevision != null
        ? `${p.publicationRevisionId}:${event.aggregateRevision}`
        : p.publicationRevisionId,
    ),
    deviceIds:
      event.eventType === PUB.desiredRevisionChanged
        ? [p.deviceId as number]
        : [],
  };
}

export interface DeliveryContext {
  deliveryId: string;
  signal: AbortSignal;
}
