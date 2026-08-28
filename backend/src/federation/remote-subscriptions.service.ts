import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type RemoteServer, type RemoteSubscription } from '@prisma/client';
import { REMOTE_ERROR_CODES, REMOTE_SUBSCRIPTION_LIMITS, parseRemoteSubscriptionView, type RemoteSubscriptionView } from '@inker/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../common/services/encryption.service';
import { PublicationPersistenceService } from '../publications/publication-persistence.service';
import { publicationArtifacts } from '../publications/publication-content';
import { cloneIsolatedJson } from '../isolation/isolation-contract';
import { sourceWrite } from '../sources/source-writes';
import { assertRemoteOrigin, canonicalRemoteBaseUrl } from './remote-transport';
import { REMOTE_SYNC, scheduleRemote } from './remote-job';
import { remoteStatus } from './remote-status';

type Db = Prisma.TransactionClient;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(value);
const tokenValid = (value: unknown): value is string => typeof value === 'string' && /^sp_share_[A-Za-z0-9_-]{64}$/.test(value);
const invalid = () => new BadRequestException('REMOTE_INVALID_COMMAND');

@Injectable()
export class RemoteSubscriptionsService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService,
    private readonly publications: PublicationPersistenceService) {}

  private input(body: unknown, keys: string[]) {
    try {
      const value = cloneIsolatedJson(body, 4096);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
      return value;
    } catch { throw invalid(); }
  }
  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('REMOTE_ALREADY_EXISTS');
      throw new ServiceUnavailableException('REMOTE_UNAVAILABLE');
    }
  }
  private async view(db: Db, row: RemoteSubscription & { server: RemoteServer }): Promise<RemoteSubscriptionView> {
    const states = await db.devicePublicationState.findMany({ where: { device: { isActive: true }, desiredRevision: { publicationId: row.localPublicationId } },
      orderBy: { deviceId: 'asc' }, take: REMOTE_SUBSCRIPTION_LIMITS.maxDeviceIds, select: { deviceId: true } });
    const status = remoteStatus(row);
    const parsed = parseRemoteSubscriptionView({ subscriptionId: row.subscriptionId, name: row.name, baseUrl: row.server.baseUrl,
      serverId: row.server.serverId, remotePublicationId: row.remotePublicationId, enabled: row.enabled, trust: 'trusted', status,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null, lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      nextSyncAt: row.nextSyncAt.toISOString(), lastErrorCode: row.lastErrorCode && REMOTE_ERROR_CODES.includes(row.lastErrorCode as typeof REMOTE_ERROR_CODES[number]) ? row.lastErrorCode : null,
      remoteRevision: row.remoteRevision, localPublicationId: row.localPublicationId, localPublicationRevisionId: row.latestLocalRevisionId,
      deviceIds: states.map(state => state.deviceId) });
    if (!parsed.success || !row.server.trusted) throw new ServiceUnavailableException('REMOTE_UNAVAILABLE');
    return parsed.data;
  }
  async list() {
    return this.safe(async () => {
      const rows = await this.prisma.remoteSubscription.findMany({ orderBy: [{ createdAt: 'asc' }, { subscriptionId: 'asc' }], take: REMOTE_SUBSCRIPTION_LIMITS.maxRows,
        include: { server: true } });
      return Promise.all(rows.map(row => this.view(this.prisma, row)));
    });
  }
  async create(body: unknown) {
    const input = this.input(body, ['name', 'baseUrl', 'serverId', 'publicationId', 'token', 'trust', 'refreshIntervalSeconds']);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > REMOTE_SUBSCRIPTION_LIMITS.maxNameLength
      || Array.from(input.name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || typeof input.baseUrl !== 'string'
      || typeof input.serverId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.serverId)
      || !identifier(input.publicationId) || !tokenValid(input.token) || input.trust !== true
      || !Number.isInteger(input.refreshIntervalSeconds) || Number(input.refreshIntervalSeconds) < 60 || Number(input.refreshIntervalSeconds) > 86400
      || input.name.includes(input.token)) throw invalid();
    let baseUrl: string;
    try { baseUrl = canonicalRemoteBaseUrl(input.baseUrl); assertRemoteOrigin(baseUrl); }
    catch (error) { throw new BadRequestException(error instanceof Error && ['REMOTE_URL_INVALID', 'REMOTE_ORIGIN_DENIED', 'REMOTE_POLICY_INVALID'].includes(error.message) ? error.message : 'REMOTE_URL_INVALID'); }
    const values = { name: input.name.trim(), serverId: input.serverId, remotePublicationId: input.publicationId, token: input.token,
      refreshIntervalSeconds: Number(input.refreshIntervalSeconds) };
    return this.safe(() => sourceWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('UPDATE remote_subscriptions SET version = version WHERE 1 = 0');
      if (await tx.remoteSubscription.count() >= REMOTE_SUBSCRIPTION_LIMITS.maxRows) throw new ConflictException('REMOTE_LIMIT');
      let server = await tx.remoteServer.findUnique({ where: { baseUrl } });
      if (server && (server.serverId !== values.serverId || !server.trusted)) throw new ConflictException('REMOTE_IDENTITY_MISMATCH');
      if (!server) server = await tx.remoteServer.create({ data: { baseUrl, serverId: values.serverId, trusted: true } });
      const subscriptionId = randomUUID();
      const publication = await tx.publication.create({ data: { publicationKey: `remote-${subscriptionId}` } });
      const credential = await tx.remoteCredential.create({ data: { ciphertext: this.encryption.encrypt(values.token) } });
      const row = await tx.remoteSubscription.create({ data: { subscriptionId, name: values.name, remoteServerId: server.remoteServerId,
        remotePublicationId: values.remotePublicationId, credentialId: credential.credentialId, localPublicationId: publication.publicationId,
        refreshIntervalSeconds: values.refreshIntervalSeconds, nextSyncAt: new Date() }, include: { server: true } });
      await scheduleRemote(tx, row, new Date());
      return this.view(tx, row);
    }, { timeout: 8000 })));
  }
  async update(id: string, body: unknown) {
    const input = this.input(body, ['enabled', 'token']);
    if (!identifier(id) || !Object.keys(input).length || (input.enabled !== undefined && typeof input.enabled !== 'boolean')
      || (input.token !== undefined && !tokenValid(input.token))) throw invalid();
    return this.safe(() => sourceWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('UPDATE remote_subscriptions SET version = version WHERE subscription_id = ?', id);
      const previous = await tx.remoteSubscription.findUnique({ where: { subscriptionId: id }, include: { server: true } });
      if (!previous) throw new NotFoundException('REMOTE_NOT_FOUND');
      if (previous.version >= 2147483647) throw new ConflictException('REMOTE_VERSION_EXHAUSTED');
      if (input.token !== undefined) {
        if (previous.name.includes(input.token as string)) throw invalid();
        await tx.remoteCredential.update({ where: { credentialId: previous.credentialId }, data: { ciphertext: this.encryption.encrypt(input.token as string) } });
      }
      const now = new Date();
      const row = await tx.remoteSubscription.update({ where: { subscriptionId: id }, data: {
        enabled: input.enabled as boolean | undefined, version: { increment: 1 }, nextSyncAt: now,
        circuitOpenUntil: null, consecutiveFailures: 0 }, include: { server: true } });
      await tx.outboxEvent.updateMany({ where: { eventType: REMOTE_SYNC, aggregateId: id, status: 'pending' }, data: { status: 'delivered', processedAt: now } });
      await scheduleRemote(tx, row, now);
      return this.view(tx, row);
    }, { timeout: 8000 })));
  }
  async sync(id: string, body: unknown) {
    this.input(body, []);
    if (!identifier(id)) throw invalid();
    return this.safe(() => sourceWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('UPDATE remote_subscriptions SET version = version WHERE subscription_id = ?', id);
      const row = await tx.remoteSubscription.findUnique({ where: { subscriptionId: id } });
      if (!row) throw new NotFoundException('REMOTE_NOT_FOUND');
      if (!row.enabled) throw new ConflictException('REMOTE_DISABLED');
      if (!await scheduleRemote(tx, row, new Date(), true)) throw new ConflictException('REMOTE_SYNC_NOT_SCHEDULED');
      return { scheduled: true };
    })));
  }
  async assign(id: string, deviceId: number, body: unknown) {
    this.input(body, []);
    if (!identifier(id) || !Number.isSafeInteger(deviceId) || deviceId < 1) throw invalid();
    return this.safe(() => sourceWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('UPDATE remote_subscriptions SET version = version WHERE subscription_id = ?', id);
      const row = await tx.remoteSubscription.findUnique({ where: { subscriptionId: id }, include: { latestLocalRevision: true } });
      if (!row) throw new NotFoundException('REMOTE_NOT_FOUND');
      if (!row.latestLocalRevision || row.latestLocalRevision.publicationId !== row.localPublicationId) throw new ConflictException('REMOTE_CACHE_UNAVAILABLE');
      if (!await tx.device.findFirst({ where: { id: deviceId, isActive: true } })) throw new NotFoundException('DEVICE_NOT_FOUND');
      publicationArtifacts(row.latestLocalRevision);
      await this.publications.setDesiredRevision(deviceId, row.latestLocalRevision.publicationRevisionId, tx);
      return { assigned: true };
    })));
  }
}
