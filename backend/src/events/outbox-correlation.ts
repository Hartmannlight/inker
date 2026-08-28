import { createHash, randomUUID } from 'node:crypto';
import { createCorrelationContext, currentCorrelation } from '../observability/correlation-context';

/** Persist at the domain intent, never in a read or retry path. */
export function intentCorrelationId(): string {
  return currentCorrelation()?.correlationId ?? randomUUID();
}

/** Legacy rows remain untouched; every process reconstructs the same UUID. */
export function outboxCorrelation(event: { eventId: string; correlationId?: string | null }) {
  let correlationId = event.correlationId;
  if (correlationId == null) {
    const bytes = createHash('sha256').update('statuspanel:legacy-outbox-correlation:v1\0').update(event.eventId).digest();
    bytes[6] = (bytes[6] & 0x0f) | 0x80; // UUIDv8: application-defined SHA-256 namespace.
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.subarray(0, 16).toString('hex');
    correlationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return createCorrelationContext({ correlationId, eventId: event.eventId });
}
