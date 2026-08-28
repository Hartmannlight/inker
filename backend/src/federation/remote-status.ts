import type { RemoteSubscriptionStatus } from '@inker/contracts';
import type { RemoteSubscription } from '@prisma/client';

export function remoteStatus(row: Pick<RemoteSubscription, 'enabled' | 'latestLocalRevisionId' | 'lastErrorCode' | 'lastSuccessAt' | 'refreshIntervalSeconds'>,
  now = new Date()): RemoteSubscriptionStatus {
  const stale = !!row.lastErrorCode || !row.lastSuccessAt || now.getTime() - row.lastSuccessAt.getTime() >= row.refreshIntervalSeconds * 2000;
  return !row.enabled ? 'disabled' : row.latestLocalRevisionId ? stale ? 'stale' : 'fresh' : row.lastErrorCode ? 'error' : 'pending';
}
