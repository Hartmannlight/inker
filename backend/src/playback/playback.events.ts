import type { EventInput } from "../events/outbox.types";

export const PLAYBACK_DUE = "playback.transition.due";
export const PLAYBACK_CHANGED = "playback.state.changed";
export function parsePlaybackEvent(event: EventInput) {
  const p = event.payload as Record<string, unknown> | null;
  const due = event.eventType === PLAYBACK_DUE;
  if (
    (!due && event.eventType !== PLAYBACK_CHANGED) ||
    event.payloadVersion !== 1 ||
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).some(
      (k) => !["playbackId", "version", ...(due ? ["dueAt"] : [])].includes(k),
    ) ||
    typeof p.playbackId !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(p.playbackId) ||
    !Number.isSafeInteger(p.version) ||
    Number(p.version) < 1 ||
    event.aggregateType !== "PlaybackState" ||
    event.aggregateId !== p.playbackId ||
    event.aggregateRevision !== String(p.version) ||
    (due &&
      (!Number.isSafeInteger(p.dueAt) ||
        Number(p.dueAt) < 0 ||
        Number(p.dueAt) > 8_000_000_000_000_000))
  ) {
    throw new Error("OUTBOX_INVALID_PAYLOAD");
  }
  return {
    playbackId: p.playbackId,
    version: Number(p.version),
    dueAt: due ? Number(p.dueAt) : null,
  };
}
