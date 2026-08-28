import type { Prisma } from '@prisma/client';
import type { QueueName } from './queue-policy';

const routes: Readonly<Record<string, QueueName>> = Object.freeze({
  'source.refresh.due': 'source-refresh',
  'render.requested': 'render',
  'playback.transition.due': 'timer',
  'timer.completion.due': 'timer',
  'maintenance.cleanup.due': 'maintenance',
  'remote.sync.due': 'remote-sync',
});
export const queueForEvent = (eventType: string): QueueName => routes[eventType] ?? 'delivery';
export function queueEventFilter(queue: QueueName): Prisma.OutboxEventWhereInput {
  return { eventType: queue === 'delivery' ? { notIn: Object.keys(routes) }
    : { in: Object.keys(routes).filter(event => routes[event] === queue) } };
}
