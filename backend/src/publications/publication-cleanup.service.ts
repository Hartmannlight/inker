import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

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

  async cleanup(now = new Date()) {
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

    return this.prisma.$transaction(async (transaction) => {
      await transaction.outboxConsumer.deleteMany({ where: { expiresAt: { lt: now } } });
      // Retain only opaque idempotency tombstones after normal event retention.
      // Pending/processing work has no age-only deletion path.
      const expiredEvents = await transaction.outboxEvent.findMany({ where: { OR: [
        { status: 'delivered', processedAt: { lt: deliveredCutoff } },
        { status: 'dead-letter', processedAt: { lt: deadLetterCutoff } },
      ] }, select: { eventId: true } });
      const expiredEffects = { effect: { eventId: { in: expiredEvents.map(event => event.eventId) } } };
      await transaction.outboxTarget.deleteMany({ where: expiredEffects });
      await transaction.outboxDelivery.deleteMany({ where: expiredEffects });
      const delivered = await transaction.outboxEvent.deleteMany({
        where: {
          status: "delivered",
          processedAt: { lt: deliveredCutoff },
        },
      });
      const deadLetter = await transaction.outboxEvent.deleteMany({
        where: {
          status: "dead-letter",
          processedAt: { lt: deadLetterCutoff },
        },
      });

      const revisions = await transaction.publicationRevision.findMany({
        orderBy: [{ publicationId: "asc" }, { revision: "desc" }],
        select: {
          publicationRevisionId: true,
          publicationId: true,
          publishedAt: true,
          desiredByDevices: { select: { deviceId: true }, take: 1 },
          acknowledgedByDevices: { select: { deviceId: true }, take: 1 },
          playlistEntries: { select: { playlistRevisionId: true }, take: 1 },
        },
      });
      const seenPublications = new Set<string>();
      const removableRevisionIds: string[] = [];
      for (const revision of revisions) {
        const latest = !seenPublications.has(revision.publicationId);
        seenPublications.add(revision.publicationId);
        const referenced =
          revision.desiredByDevices.length > 0 ||
          revision.acknowledgedByDevices.length > 0 || revision.playlistEntries.length > 0;
        if (!latest && !referenced && revision.publishedAt < revisionCutoff) {
          removableRevisionIds.push(revision.publicationRevisionId);
        }
      }

      const oldRevisions = removableRevisionIds.length
        ? await transaction.publicationRevision.deleteMany({
            where: { publicationRevisionId: { in: removableRevisionIds } },
          })
        : { count: 0 };

      return {
        deliveredOutboxEvents: delivered.count,
        deadLetterOutboxEvents: deadLetter.count,
        publicationRevisions: oldRevisions.count,
      };
    });
  }

  private daysBefore(now: Date, days: number) {
    return new Date(now.getTime() - days * DAY_IN_MS);
  }
}
