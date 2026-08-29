import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { intentCorrelationId } from '../events/outbox-correlation';
import {
  AppendPublicationRevisionInput,
  CreatePublicationInput,
  OUTBOX_PAYLOAD_VERSION,
  OutboxDebugQuery,
  PUBLICATION_EVENT_TYPES,
} from "./publication-persistence.types";

type TransactionClient = Prisma.TransactionClient;

@Injectable()
export class PublicationPersistenceService {
  constructor(private readonly prisma: PrismaService) {}

  async createPublication(input: CreatePublicationInput, tx?: TransactionClient) {
    this.assertRevisionInput(input);
    const occurredAt = input.publishedAt ?? new Date();

    return this.run(tx, async (transaction) => {
      const publication = await transaction.publication.create({
        data: { publicationKey: input.publicationKey },
      });
      const revision = await transaction.publicationRevision.create({
        data: {
          publicationId: publication.publicationId,
          revision: 1,
          protocolVersion: input.protocolVersion,
          content: input.content,
          contentHash: input.contentHash,
          publishedAt: occurredAt,
        },
      });

      await this.createOutboxEvent(transaction, {
        eventType: PUBLICATION_EVENT_TYPES.revisionCreated,
        aggregateType: "PublicationRevision",
        aggregateId: revision.publicationRevisionId,
        payload: {
          publicationId: publication.publicationId,
          publicationKey: publication.publicationKey,
          publicationRevisionId: revision.publicationRevisionId,
          revision: revision.revision,
          protocolVersion: revision.protocolVersion,
          contentHash: revision.contentHash,
        },
        occurredAt,
      });

      return { publication, revision };
    });
  }

  async appendRevision(input: AppendPublicationRevisionInput, tx?: TransactionClient) {
    this.assertRevisionInput(input);
    const occurredAt = input.publishedAt ?? new Date();

    return this.run(tx, async (transaction) => {
      const publication = await transaction.publication.findUnique({
        where: { publicationId: input.publicationId },
      });
      if (!publication) throw new NotFoundException("Publication not found");

      const latest = await transaction.publicationRevision.findFirst({
        where: { publicationId: publication.publicationId },
        orderBy: { revision: "desc" },
        select: { revision: true },
      });
      const revision = await transaction.publicationRevision.create({
        data: {
          publicationId: publication.publicationId,
          revision: (latest?.revision ?? 0) + 1,
          protocolVersion: input.protocolVersion,
          content: input.content,
          contentHash: input.contentHash,
          publishedAt: occurredAt,
        },
      });

      await this.createOutboxEvent(transaction, {
        eventType: PUBLICATION_EVENT_TYPES.revisionCreated,
        aggregateType: "PublicationRevision",
        aggregateId: revision.publicationRevisionId,
        payload: {
          publicationId: publication.publicationId,
          publicationKey: publication.publicationKey,
          publicationRevisionId: revision.publicationRevisionId,
          revision: revision.revision,
          protocolVersion: revision.protocolVersion,
          contentHash: revision.contentHash,
        },
        occurredAt,
      });

      return revision;
    });
  }

  async setDesiredRevision(deviceId: number, publicationRevisionId: string, tx?: TransactionClient, playbackId?: string) {
    const occurredAt = new Date();

    return this.run(tx, async (transaction) => {
      // Serialize assignment commands before reading the current pointer.
      await transaction.$executeRaw`UPDATE devices SET id = id WHERE id = ${deviceId}`;
      const playback = await transaction.playbackState.findUnique({ where: { deviceId } });
      if (playback && ['running', 'paused'].includes(playback.status) && playback.id !== playbackId)
        throw new ConflictException('Stop playback before assigning a publication');
      const current = await transaction.devicePublicationState.findUnique({ where: { deviceId } });
      if (current?.desiredPublicationRevisionId === publicationRevisionId) return current;
      const revision = await this.requireRevision(
        transaction,
        publicationRevisionId,
      );
      const device = await transaction.device.update({ where: { id: deviceId },
        data: { presentationRevision: { increment: 1 } }, select: { presentationRevision: true } });
      const state = await transaction.devicePublicationState.upsert({
        where: { deviceId },
        create: {
          deviceId,
          desiredPublicationRevisionId: publicationRevisionId,
          desiredSequence: device.presentationRevision,
          desiredAt: occurredAt,
        },
        update: {
          desiredPublicationRevisionId: publicationRevisionId,
          desiredSequence: device.presentationRevision,
          desiredAt: occurredAt,
        },
      });

      // Browser compatibility sequence: advances on explicit assignment only,
      // including switching back to an older revision or another publication.

      await this.createOutboxEvent(transaction, {
        eventType: PUBLICATION_EVENT_TYPES.desiredRevisionChanged,
        aggregateType: "DevicePublicationState",
        aggregateId: String(deviceId),
        aggregateRevision: String(device.presentationRevision),
        payload: {
          deviceId,
          publicationId: revision.publicationId,
          publicationRevisionId,
          revision: revision.revision,
        },
        occurredAt,
      });

      return state;
    });
  }

  async acknowledgeRevision(deviceId: number, publicationRevisionId: string) {
    const occurredAt = new Date();

    return this.prisma.$transaction(async (transaction) => {
      const revision = await this.requireRevision(
        transaction,
        publicationRevisionId,
      );
      const state = await transaction.devicePublicationState.upsert({
        where: { deviceId },
        create: {
          deviceId,
          acknowledgedPublicationRevisionId: publicationRevisionId,
          acknowledgedAt: occurredAt,
        },
        update: {
          acknowledgedPublicationRevisionId: publicationRevisionId,
          acknowledgedAt: occurredAt,
        },
      });

      await this.createOutboxEvent(transaction, {
        eventType: PUBLICATION_EVENT_TYPES.revisionAcknowledged,
        aggregateType: "DevicePublicationState",
        aggregateId: String(deviceId),
        payload: {
          deviceId,
          publicationId: revision.publicationId,
          publicationRevisionId,
          revision: revision.revision,
        },
        occurredAt,
      });

      return state;
    });
  }

  /** Clear the canonical desired pointer without touching acknowledged history. */
  async clearDesiredRevision(deviceId: number, tx?: TransactionClient) {
    const occurredAt = new Date();
    return this.run(tx, async transaction => {
      await transaction.$executeRaw`UPDATE devices SET id = id WHERE id = ${deviceId}`;
      const current = await transaction.devicePublicationState.findUnique({ where: { deviceId } });
      if (!current?.desiredPublicationRevisionId) return current;
      const device = await transaction.device.update({ where: { id: deviceId }, data: { presentationRevision: { increment: 1 } }, select: { presentationRevision: true } });
      const state = await transaction.devicePublicationState.update({ where: { deviceId }, data: { desiredPublicationRevisionId: null, desiredSequence: device.presentationRevision, desiredAt: occurredAt } });
      await this.createOutboxEvent(transaction, { eventType: PUBLICATION_EVENT_TYPES.desiredRevisionCleared,
        aggregateType: 'DevicePublicationState', aggregateId: String(deviceId), aggregateRevision: String(device.presentationRevision),
        payload: { deviceId }, occurredAt });
      return state;
    });
  }

  async getPublication(publicationKey: string) {
    return this.prisma.publication.findUnique({
      where: { publicationKey },
      include: { revisions: { orderBy: { revision: "desc" } } },
    });
  }

  async getDevicePublicationState(deviceId: number) {
    return this.prisma.devicePublicationState.findUnique({
      where: { deviceId },
      include: { desiredRevision: true, acknowledgedRevision: true },
    });
  }

  async listOutboxEvents(query: OutboxDebugQuery = {}) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    return this.prisma.outboxEvent.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.eventType ? { eventType: query.eventType } : {}),
      },
      orderBy: { occurredAt: "desc" },
      take: limit,
    });
  }

  async getOutboxStatusCounts() {
    const statuses = ["pending", "processing", "delivered", "dead-letter"];
    const counts = await Promise.all(
      statuses.map(async (status) => ({
        status,
        count: await this.prisma.outboxEvent.count({ where: { status } }),
      })),
    );
    return Object.fromEntries(
      counts.map(({ status, count }) => [status, count]),
    );
  }

  private async requireRevision(
    transaction: TransactionClient,
    publicationRevisionId: string,
  ) {
    const revision = await transaction.publicationRevision.findUnique({
      where: { publicationRevisionId },
      select: { publicationId: true, revision: true },
    });
    if (!revision)
      throw new NotFoundException("Publication revision not found");
    return revision;
  }

  private async createOutboxEvent(
    transaction: TransactionClient,
    input: {
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      aggregateRevision?: string;
      payload: Prisma.InputJsonValue;
      occurredAt: Date;
    },
  ) {
    return transaction.outboxEvent.create({
      data: {
        ...input,
        correlationId: intentCorrelationId(),
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        availableAt: input.occurredAt,
      },
    });
  }

  private run<T>(tx: TransactionClient | undefined, operation: (transaction: TransactionClient) => Promise<T>): Promise<T> {
    return tx ? operation(tx) : this.prisma.$transaction(operation);
  }

  private assertRevisionInput(input: {
    protocolVersion: string;
    contentHash: string;
  }) {
    if (!input.protocolVersion.trim()) {
      throw new Error("protocolVersion must not be empty");
    }
    if (!input.contentHash.trim()) {
      throw new Error("contentHash must not be empty");
    }
  }
}
