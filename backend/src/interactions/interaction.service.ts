import { BadRequestException, HttpException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { INTERACTION_LIMITS, parseInteractionEvent, type AllowedAction, type CommandResult, type InteractionEvent } from '@inker/contracts';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from '../common/utils/crypto.util';
import { canonicalJson, publicationAllowedActions, sha256 } from '../publications/publication-content';
import { RenderCacheService } from '../render-cache/render-cache.service';
import { cloneIsolatedJson } from '../isolation/isolation-contract';
import { sqliteWrite } from '../sources/source-writes';
import { CommandRegistry, type HandlerResult } from './command-registry';

type Tx = Prisma.TransactionClient;
const include = { device: { include: { profile: true, deliveryPolicy: true } } } as const;
type Credential = Prisma.DeviceCredentialGetPayload<{ include: typeof include }>;
@Injectable()
export class InteractionClock { now() { return Date.now(); } }

@Injectable()
export class InteractionService {
  constructor(private readonly prisma: PrismaService, private readonly registry: CommandRegistry,
    private readonly cache: RenderCacheService, private readonly clock: InteractionClock) {}

  private token(headers: IncomingHttpHeaders) {
    const match = typeof headers.authorization === 'string' && /^Bearer ([A-Za-z0-9_-]{32,512})$/i.exec(headers.authorization);
    if (!match || headers.http_id !== undefined || headers['access-token'] !== undefined) throw new UnauthorizedException('INTERACTION_AUTHENTICATION_FAILED');
    return match[1];
  }
  private async authenticate(db: Tx, token: string): Promise<Credential> {
    const credential = await db.deviceCredential.findUnique({ where: { tokenHash: hashToken(token) }, include });
    if (!credential || credential.revokedAt || (credential.expiresAt && credential.expiresAt.getTime() <= this.clock.now())
      || !credential.device.isActive || !credential.device.externalId) throw new UnauthorizedException('INTERACTION_AUTHENTICATION_FAILED');
    return credential;
  }
  private normalize(input: unknown, token: string): InteractionEvent {
    try {
      const value = cloneIsolatedJson(input, INTERACTION_LIMITS.messageBytes);
      if (JSON.stringify(value).includes(token)) throw new Error();
      const parsed = parseInteractionEvent(value);
      if (!parsed.success) throw new Error();
      return parsed.data;
    } catch { throw new BadRequestException('INTERACTION_INVALID_INPUT'); }
  }
  private async surface(db: Tx, credential: Credential, observe = true) {
    const state = await db.devicePublicationState.findUnique({ where: { deviceId: credential.deviceId }, include: { desiredRevision: true } });
    const revision = state?.desiredRevision;
    if (!revision) {
      const allowedActions: AllowedAction[] = [];
      return { state, revision: null, allowedActions };
    }
    const rendered = await this.cache.read(credential.device, revision, db, observe);
    const allowedActions = rendered && !rendered.fallback && rendered.revision.publicationRevisionId === revision.publicationRevisionId
      ? publicationAllowedActions(revision) : [];
    return { state, revision, allowedActions };
  }
  /** Read-only capability context; no credential token, draft or source values. */
  async context(headers: IncomingHttpHeaders) {
    const token = this.token(headers);
    try {
      const credential = await this.authenticate(this.prisma, token);
      const surface = await this.surface(this.prisma, credential);
      const playback = await this.prisma.playbackState.findUnique({ where: { deviceId: credential.deviceId }, select: { version: true } });
      return { protocolVersion: '1.0', deviceId: credential.device.externalId!, credentialId: credential.credentialId,
        serverTime: new Date(this.clock.now()).toISOString(),
        publicationId: surface.revision?.publicationId ?? null, revision: surface.revision ? String(surface.revision.revision) : null,
        allowedActions: surface.allowedActions,
        playback: { version: playback?.version ?? 0, desiredSequence: surface.state?.desiredSequence ?? credential.device.presentationRevision } };
    } catch (error) { if (error instanceof UnauthorizedException) throw error; throw new ServiceUnavailableException('INTERACTION_UNAVAILABLE'); }
  }
  private rejected(event: InteractionEvent, commandId: string, code: string): CommandResult {
    return { protocolVersion: '1.0', eventId: event.eventId, commandId, status: 'rejected',
      serverTime: new Date(this.clock.now()).toISOString(), error: { code, message: code, retryable: false } };
  }
  private async consumeRate(tx: Tx, deviceId: number) {
    const previous = await tx.interactionRate.findUnique({ where: { deviceId } });
    const now = Math.max(this.clock.now(), previous?.minuteAt.getTime() ?? 0, previous?.secondAt.getTime() ?? 0);
    const minuteAt = new Date(Math.floor(now / 60_000) * 60_000), secondAt = new Date(Math.floor(now / 1000) * 1000);
    const minuteCount = (previous?.minuteAt.getTime() === minuteAt.getTime() ? previous.minuteCount : 0) + 1;
    const secondCount = (previous?.secondAt.getTime() === secondAt.getTime() ? previous.secondCount : 0) + 1;
    if (minuteCount > INTERACTION_LIMITS.perMinute || secondCount > INTERACTION_LIMITS.perSecond) throw new HttpException('INTERACTION_RATE_LIMITED', 429);
    const data = { minuteAt, minuteCount, secondAt, secondCount };
    await tx.interactionRate.upsert({ where: { deviceId }, create: { deviceId, ...data }, update: data });
  }

  async execute(headers: IncomingHttpHeaders, input: unknown): Promise<CommandResult> {
    const token = this.token(headers), event = this.normalize(input, token);
    const requestHash = sha256(canonicalJson(event));
    try {
      const initial = await this.authenticate(this.prisma, token);
      return await sqliteWrite(this.prisma, () => this.prisma.$transaction(async tx => {
        // Acquire SQLite's writer lock before identity, receipt and domain reads.
        await tx.$executeRaw`UPDATE devices SET id = id WHERE id = ${initial.deviceId}`;
        const credential = await this.authenticate(tx, token);
        if (credential.deviceId !== initial.deviceId || event.deviceId !== credential.device.externalId
          || event.credentialId !== credential.credentialId) throw new UnauthorizedException('INTERACTION_AUTHENTICATION_FAILED');
        const where = { deviceId_eventId: { deviceId: credential.deviceId, eventId: event.eventId } };
        const receipt = await tx.interactionReceipt.findUnique({ where });
        if (receipt) {
          if (receipt.requestHash !== requestHash || receipt.credentialId !== credential.credentialId) return this.rejected(event, receipt.commandId, 'INTERACTION_EVENT_CONFLICT');
          // A committed view.next may itself change the current publication/time.
          // Replay is authorized by current credentials, not a second domain run.
          return { ...(receipt.result as unknown as CommandResult), status: 'duplicate' };
        }
        await this.consumeRate(tx, credential.deviceId);
        const commandId = randomUUID(), age = this.clock.now() - Date.parse(event.occurredAt);
        let code = age > INTERACTION_LIMITS.maxAgeMs ? 'INTERACTION_EXPIRED'
          : age < -INTERACTION_LIMITS.maxFutureMs ? 'INTERACTION_FUTURE' : undefined;
        if (!code && event.clientSequence !== undefined) {
          const sequence = await tx.interactionSequence.findUnique({ where: { credentialId: credential.credentialId } });
          if (sequence && event.clientSequence <= sequence.lastSequence) code = 'INTERACTION_SEQUENCE_REPLAY';
        }
        const surface = code ? null : await this.surface(tx, credential, false);
        if (!code && (!surface?.revision || surface.revision.publicationId !== event.publicationId
          || String(surface.revision.revision) !== event.revision)) code = 'INTERACTION_NOT_ALLOWED';
        const permission = surface?.allowedActions.find(item => item.action === event.action && item.targetId === event.targetId);
        if (!code && !permission) code = 'INTERACTION_NOT_ALLOWED';
        const handler = this.registry.get(event.action);
        if (!code && (!handler || permission?.payloadSchemaVersion !== handler.payloadSchemaVersion)) code = 'INTERACTION_UNKNOWN_ACTION';
        let payload: unknown, output: HandlerResult | undefined;
        if (!code) {
          try { payload = handler!.validate(event.payload); } catch { code = 'INTERACTION_INVALID_PAYLOAD'; }
        }
        if (!code) {
          await tx.$executeRawUnsafe('SAVEPOINT interaction_handler');
          try {
            const candidate = cloneIsolatedJson(await handler!.execute(tx, { deviceId: credential.deviceId, externalId: credential.device.externalId!, credentialId: credential.credentialId }, payload, event, commandId), INTERACTION_LIMITS.payloadBytes);
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
              || Object.keys(candidate).some(key => !['stateRevision', 'result'].includes(key))
              || (candidate.stateRevision !== undefined && (typeof candidate.stateRevision !== 'string' || candidate.stateRevision.length > 128))
              || JSON.stringify(candidate).includes(token)) throw new Error('INTERACTION_INVALID_RESULT');
            output = candidate as HandlerResult;
            await tx.$executeRawUnsafe('RELEASE interaction_handler');
          } catch (error) {
            // Domain rejection must not commit any partial handler writes.
            await tx.$executeRawUnsafe('ROLLBACK TO interaction_handler');
            await tx.$executeRawUnsafe('RELEASE interaction_handler');
            if (error instanceof HttpException && [400, 404, 409].includes(error.getStatus())) code = 'INTERACTION_STATE_CONFLICT';
            else throw error;
          }
        }
        const result: CommandResult = code ? this.rejected(event, commandId, code) : {
          protocolVersion: '1.0', eventId: event.eventId, commandId, status: 'accepted',
          serverTime: new Date(this.clock.now()).toISOString(), ...output,
        };
        if (!code && event.clientSequence !== undefined) await tx.interactionSequence.upsert({
          where: { credentialId: credential.credentialId }, create: { credentialId: credential.credentialId, lastSequence: event.clientSequence },
          update: { lastSequence: event.clientSequence },
        });
        await tx.interactionReceipt.create({ data: { deviceId: credential.deviceId, eventId: event.eventId, commandId,
          credentialId: credential.credentialId, publicationId: event.publicationId, publicationRevision: event.revision,
          action: event.action, targetId: event.targetId, requestHash, result: result as unknown as Prisma.InputJsonValue,
          createdAt: new Date(this.clock.now()) } });
        await this.authenticate(tx, token); // An expiry while processing rolls back the entire command.
        return result;
      }, { timeout: 5000 }), 'INTERACTION_UNAVAILABLE');
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof HttpException && error.getStatus() === 429) throw error;
      throw new ServiceUnavailableException('INTERACTION_UNAVAILABLE');
    }
  }
}
