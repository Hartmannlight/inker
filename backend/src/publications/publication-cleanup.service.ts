import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MAINTENANCE_BATCH_SIZE } from "../jobs/services/log-cleanup.service";
import { sqliteWrite } from "../sources/source-writes";

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export const PUBLICATION_RETENTION_POLICY = {
  deliveredOutboxDays: 30,
  deadLetterOutboxDays: 90,
  unreferencedRevisionDays: 90,
  pendingOutbox: "retain-until-processed",
  processingOutbox: "retain-until-recovered",
  latestRevision: "always-retain",
  referencedRevision: "always-retain",
  publicationIdentity: "never-delete-automatically",
} as const;

@Injectable()
export class PublicationCleanupService {
  constructor(private readonly prisma: PrismaService) {}

  async cleanup(now = new Date(), transaction?: Prisma.TransactionClient) {
    const totals = { deliveredOutboxEvents: 0, deadLetterOutboxEvents: 0, publicationRevisions: 0 };
    const runBatch = async (tx: Prisma.TransactionClient, revisionCursor?: string) => {
      const batch = await this.cleanupBatch(now, tx, revisionCursor);
      totals.deliveredOutboxEvents += batch.deliveredOutboxEvents;
      totals.deadLetterOutboxEvents += batch.deadLetterOutboxEvents;
      totals.publicationRevisions += batch.publicationRevisions;
      return batch;
    };
    if (transaction) {
      let revisionCursor: string | undefined;
      for (;;) {
        const batch = await runBatch(transaction, revisionCursor);
        if ('revisionCursor' in batch && batch.revisionCursor) revisionCursor = batch.revisionCursor;
        if (batch.done) return totals;
      }
    }
    let revisionCursor: string | undefined;
    for (;;) {
      const batch = await sqliteWrite(this.prisma, () => this.prisma.$transaction(
        tx => runBatch(tx, revisionCursor),
      ));
      if ('revisionCursor' in batch && batch.revisionCursor) revisionCursor = batch.revisionCursor;
      if (batch.done) return totals;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  async cleanupBatch(now: Date, transaction: Prisma.TransactionClient, revisionCursor?: string) {
    const deliveredCutoff = this.daysBefore(
      now,
      PUBLICATION_RETENTION_POLICY.deliveredOutboxDays,
    );
    const deadLetterCutoff = this.daysBefore(
      now,
      PUBLICATION_RETENTION_POLICY.deadLetterOutboxDays,
    );
    const revisionCutoff = this.daysBefore(
      now,
      PUBLICATION_RETENTION_POLICY.unreferencedRevisionDays,
    );
    const empty = { deliveredOutboxEvents: 0, deadLetterOutboxEvents: 0, publicationRevisions: 0 };

    const consumers = await transaction.outboxConsumer.findMany({
      where: { expiresAt: { lt: now } }, orderBy: { consumerId: "asc" },
      take: MAINTENANCE_BATCH_SIZE, select: { consumerId: true },
    });
    if (consumers.length) {
      await transaction.outboxConsumer.deleteMany({ where: { consumerId: { in: consumers.map(row => row.consumerId) } } });
      return { ...empty, done: false };
    }

    // Pending/processing work has no age-only deletion path. Child rows are
    // drained in fixed batches before their terminal event metadata is removed.
    const expiredEvents = await transaction.outboxEvent.findMany({
      where: { OR: [
        { status: "delivered", processedAt: { lt: deliveredCutoff } },
        { status: "dead-letter", processedAt: { lt: deadLetterCutoff } },
      ] }, orderBy: { eventId: "asc" }, take: MAINTENANCE_BATCH_SIZE,
      select: { eventId: true, status: true },
    });
    if (expiredEvents.length) {
      const eventIds = expiredEvents.map(row => row.eventId);
      const targets = await transaction.outboxTarget.findMany({
        where: { effect: { eventId: { in: eventIds } } },
        orderBy: [{ effectKey: "asc" }, { consumerId: "asc" }],
        take: MAINTENANCE_BATCH_SIZE, select: { effectKey: true, consumerId: true },
      });
      if (targets.length) {
        await transaction.outboxTarget.deleteMany({ where: { OR: targets.map(row => ({
          effectKey: row.effectKey, consumerId: row.consumerId,
        })) } });
        return { ...empty, done: false };
      }
      const deliveries = await transaction.outboxDelivery.findMany({
        where: { effect: { eventId: { in: eventIds } } }, orderBy: { deliveryId: "asc" },
        take: MAINTENANCE_BATCH_SIZE, select: { deliveryId: true },
      });
      if (deliveries.length) {
        await transaction.outboxDelivery.deleteMany({ where: { deliveryId: { in: deliveries.map(row => row.deliveryId) } } });
        return { ...empty, done: false };
      }
      await transaction.outboxEvent.deleteMany({ where: { eventId: { in: eventIds } } });
      return {
        deliveredOutboxEvents: expiredEvents.filter(row => row.status === "delivered").length,
        deadLetterOutboxEvents: expiredEvents.filter(row => row.status === "dead-letter").length,
        publicationRevisions: 0, done: false,
      };
    }

    // Scan the primary-key index in fixed pages. Reference and latest checks
    // therefore evaluate at most one batch while the worker owns SQLite.
    const revisions = await transaction.publicationRevision.findMany({
      where: revisionCursor ? { publicationRevisionId: { gt: revisionCursor } } : undefined,
      orderBy: { publicationRevisionId: "asc" }, take: MAINTENANCE_BATCH_SIZE,
      select: {
        publicationRevisionId: true, publicationId: true, revision: true, publishedAt: true,
        desiredByDevices: { select: { deviceId: true }, take: 1 },
        acknowledgedByDevices: { select: { deviceId: true }, take: 1 },
        playlistEntries: { select: { playlistRevisionId: true }, take: 1 },
        renderRequests: { select: { key: true }, take: 1 },
        remoteLatestFor: { select: { subscriptionId: true }, take: 1 },
      },
    });
    if (revisions.length) {
      const latest = new Map((await transaction.publicationRevision.groupBy({
        by: ["publicationId"], where: { publicationId: { in: [...new Set(revisions.map(row => row.publicationId))] } },
        _max: { revision: true },
      })).map(row => [row.publicationId, row._max.revision]));
      const removable = revisions.filter(row => row.publishedAt < revisionCutoff
        && row.revision !== latest.get(row.publicationId)
        && !row.desiredByDevices.length && !row.acknowledgedByDevices.length
        && !row.playlistEntries.length && !row.renderRequests.length && !row.remoteLatestFor.length);
      const deleted = await transaction.publicationRevision.deleteMany({ where: {
        publicationRevisionId: { in: removable.map(row => row.publicationRevisionId) },
      } });
      return { ...empty, publicationRevisions: deleted.count, done: false,
        revisionCursor: revisions[revisions.length - 1].publicationRevisionId };
    }

    // The durable cursor makes ordinary pages and crash recovery bounded. This
    // final indexed probe closes races from inserts or reference changes behind
    // that cursor and is linearized with the maintenance receipt by its writer
    // transaction. Stragglers are still deleted in fixed-size batches.
    const stragglers = await this.removableRevisionIds(transaction, revisionCutoff);
    if (stragglers.length) {
      const deleted = await transaction.publicationRevision.deleteMany({ where: {
        publicationRevisionId: { in: stragglers },
      } });
      if (deleted.count !== stragglers.length) throw new Error("PUBLICATION_CLEANUP_CONFLICT");
      return { ...empty, publicationRevisions: deleted.count, done: false };
    }
    return { ...empty, done: true };
  }

  private async removableRevisionIds(transaction: Prisma.TransactionClient, cutoff: Date) {
    const rows = await transaction.$queryRaw<Array<{ publicationRevisionId: string }>>(Prisma.sql`
      SELECT revision.publication_revision_id AS "publicationRevisionId"
      FROM publication_revisions revision
      WHERE revision.published_at < ${cutoff}
        AND EXISTS (
          SELECT 1 FROM publication_revisions newer
          WHERE newer.publication_id = revision.publication_id
            AND newer.revision > revision.revision
        )
        AND NOT EXISTS (
          SELECT 1 FROM device_publication_states state
          WHERE state.desired_publication_revision_id = revision.publication_revision_id
             OR state.acknowledged_publication_revision_id = revision.publication_revision_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM published_playlist_entries entry
          WHERE entry.publication_revision_id = revision.publication_revision_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM render_requests request
          WHERE request.publication_revision_id = revision.publication_revision_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM remote_subscriptions subscription
          WHERE subscription.latest_local_revision_id = revision.publication_revision_id
        )
      ORDER BY revision.publication_revision_id
      LIMIT ${MAINTENANCE_BATCH_SIZE}
    `);
    return rows.map(row => row.publicationRevisionId);
  }

  private daysBefore(now: Date, days: number) {
    return new Date(now.getTime() - days * DAY_IN_MS);
  }
}
