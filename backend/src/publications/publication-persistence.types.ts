import { Prisma } from "@prisma/client";

export const PUBLICATION_EVENT_TYPES = {
  revisionCreated: "publication.revision.created",
  desiredRevisionChanged: "device.publication.desired-revision.changed",
  desiredRevisionCleared: "device.publication.desired-revision.cleared",
  revisionAcknowledged: "device.publication.revision.acknowledged",
} as const;

export const OUTBOX_PAYLOAD_VERSION = 1;

export type OutboxStatus =
  | "pending"
  | "processing"
  | "delivered"
  | "dead-letter";

export interface CreatePublicationInput {
  publicationKey: string;
  protocolVersion: string;
  content: Prisma.InputJsonValue;
  contentHash: string;
  publishedAt?: Date;
}

export interface AppendPublicationRevisionInput {
  publicationId: string;
  protocolVersion: string;
  content: Prisma.InputJsonValue;
  contentHash: string;
  publishedAt?: Date;
}

export interface OutboxDebugQuery {
  status?: OutboxStatus;
  eventType?: string;
  limit?: number;
}
