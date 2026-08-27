import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { parseSourceDefinition } from '@inker/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../common/services/encryption.service';
import { validateConnectorConfiguration, type ConnectorType } from './connectors';
import { scheduleSource } from './source-job';
import { publicDefinition } from './source-read.service';
import { sourceWrite } from './source-writes';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('SOURCE_INVALID_COMMAND');
  return value as Record<string, unknown>;
}
function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some(item => containsSecret(item, secret));
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) => key.includes(secret) || containsSecret(item, secret));
  return false;
}

@Injectable()
export class SourcesService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService) {}
  private input(body: unknown, update: boolean) {
    const value = record(body);
    const allowed = ['protocolVersion', 'name', 'connectorType', 'schemaVersion', 'configuration', 'secret', 'refreshIntervalSeconds', 'timeoutMs', 'concurrencyGroup', 'enabled', ...(update ? ['expectedDefinitionVersion'] : [])];
    if (Object.keys(value).some(key => !allowed.includes(key)) || value.protocolVersion !== '1.0'
      || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120
      || !['fixture', 'slow', 'failure'].includes(String(value.connectorType)) || value.schemaVersion !== '1'
      || (value.enabled !== undefined && typeof value.enabled !== 'boolean')
      || (update && (!Number.isSafeInteger(value.expectedDefinitionVersion) || Number(value.expectedDefinitionVersion) < 1))
      || (value.secret !== undefined && value.secret !== null && (typeof value.secret !== 'string' || !value.secret.length || value.secret.length > 4096))) {
      throw new BadRequestException('SOURCE_INVALID_COMMAND');
    }
    let configuration;
    try { configuration = validateConnectorConfiguration(value.connectorType as ConnectorType, value.configuration); }
    catch { throw new BadRequestException('SOURCE_INVALID_CONFIGURATION'); }
    const data = { name: value.name.trim(), connectorType: value.connectorType as ConnectorType,
      schemaVersion: '1', configuration: configuration as unknown as Prisma.InputJsonObject,
      refreshIntervalSeconds: value.refreshIntervalSeconds as number, timeoutMs: value.timeoutMs as number,
      concurrencyGroup: value.concurrencyGroup as string, enabled: value.enabled !== false };
    if (!parseSourceDefinition({ ...data, protocolVersion: '1.0', sourceDefinitionId: randomUUID(), definitionVersion: 1, secretReferences: {} }).success) throw new BadRequestException('SOURCE_INVALID_COMMAND');
    if (typeof value.secret === 'string' && containsSecret(data, value.secret)) throw new BadRequestException('SOURCE_SECRET_IN_PUBLIC_CONFIGURATION');
    return { data, secret: value.secret as string | null | undefined, expectedVersion: Number(value.expectedDefinitionVersion) };
  }
  async create(body: unknown) {
    const input = this.input(body, false);
    return sourceWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      const secret = input.secret ? await tx.sourceSecret.create({ data: { ciphertext: this.encryption.encrypt(input.secret) } }) : null;
      const source = await tx.sourceDefinition.create({ data: { ...input.data, secretId: secret?.id, nextRefreshAt: new Date() } });
      const eventId = await scheduleSource(tx, source, new Date());
      return { definition: publicDefinition(source), enabled: source.enabled, eventId };
    }));
  }
  async update(id: string, body: unknown) {
    const input = this.input(body, true);
    return sourceWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE source_definitions SET definition_version = definition_version WHERE source_definition_id = ${id}`;
      const previous = await tx.sourceDefinition.findUnique({ where: { sourceDefinitionId: id } });
      if (!previous) throw new NotFoundException('SOURCE_NOT_FOUND');
      if (previous.definitionVersion !== input.expectedVersion) throw new ConflictException('SOURCE_VERSION_CONFLICT');
      let secretId = previous.secretId;
      if (input.secret === null) secretId = null;
      else if (input.secret !== undefined) secretId = (await tx.sourceSecret.create({ data: { ciphertext: this.encryption.encrypt(input.secret) } })).id;
      const now = new Date();
      const source = await tx.sourceDefinition.update({ where: { sourceDefinitionId: id }, data: {
        ...input.data, secretId, definitionVersion: { increment: 1 }, nextRefreshAt: now,
        consecutiveFailures: 0, circuitOpenUntil: null,
      } });
      // Old running jobs observe the definition fence; pending work is terminal.
      await tx.outboxEvent.updateMany({ where: { eventType: 'source.refresh.due', aggregateId: id, status: 'pending' },
        data: { status: 'delivered', processedAt: now } });
      const eventId = await scheduleSource(tx, source, now);
      return { definition: publicDefinition(source), enabled: source.enabled, eventId };
    }));
  }
  async refresh(id: string) {
    return sourceWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE source_definitions SET definition_version = definition_version WHERE source_definition_id = ${id}`;
      const source = await tx.sourceDefinition.findUnique({ where: { sourceDefinitionId: id } });
      if (!source) throw new NotFoundException('SOURCE_NOT_FOUND');
      if (!source.enabled) throw new ConflictException('SOURCE_DISABLED');
      return { eventId: await scheduleSource(tx, source, new Date(), true) };
    }));
  }
}
