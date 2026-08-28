import { createHash } from 'node:crypto';
import { parseTimerFeed, type TimerFeed } from '@inker/contracts';

export function timerFeedResult(value: unknown): { feed: TimerFeed; etag: string } {
  const parsed = parseTimerFeed(value);
  if (!parsed.success) throw new Error('TIMER_INVALID_FEED');
  const feed = parsed.data;
  // Time samples travel separately; an unchanged collection remains cacheable.
  const hash = createHash('sha256').update(JSON.stringify([feed.protocolVersion, feed.timers])).digest('hex');
  return { feed, etag: `W/"${hash}"` };
}
