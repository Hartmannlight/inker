import { expect, test } from 'bun:test';
import { queueEventFilter, queueForEvent } from './queue-routing';
import { SOURCE_REFRESH } from '../sources/source-job';
import { REMOTE_SYNC } from '../federation/remote-job';
import { TIMER_DUE } from '../timers/timer-scheduling';
import { PLAYBACK_DUE } from '../playback/playback.events';
import { RENDER_REQUESTED } from '../render-cache/render-cache.service';
import { MAINTENANCE_DUE } from './maintenance.service';

test('dispatcher and diagnostic routing cover every domain job without fallback misclassification', () => {
  const events = [SOURCE_REFRESH, REMOTE_SYNC, TIMER_DUE, PLAYBACK_DUE, RENDER_REQUESTED, MAINTENANCE_DUE];
  expect(events.map(queueForEvent)).toEqual(['source-refresh', 'remote-sync', 'timer', 'timer', 'render', 'maintenance']);
  expect(queueForEvent('device.publication.desired-revision.changed')).toBe('delivery');
  expect(queueEventFilter('delivery')).toEqual({ eventType: { notIn: expect.arrayContaining(events) } });
  expect(queueEventFilter('timer')).toEqual({ eventType: { in: expect.arrayContaining([TIMER_DUE, PLAYBACK_DUE]) } });
});
