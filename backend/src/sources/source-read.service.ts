import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { SourceDefinition, SourceSnapshot } from '@prisma/client';
import { parseSourceDefinition, parseSourceSnapshot, type JsonValue } from '@inker/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalJson, sha256 } from '../publications/publication-content';

export function publicDefinition(source: SourceDefinition) {
  const result = {
    protocolVersion: '1.0', sourceDefinitionId: source.sourceDefinitionId,
    definitionVersion: source.definitionVersion, name: source.name,
    connectorType: source.connectorType, schemaVersion: source.schemaVersion,
    configuration: source.configuration, secretReferences: source.secretId ? { provider: source.secretId } : {},
    ...(source.transformationCode != null ? { transformationCode: source.transformationCode } : {}),
    refreshIntervalSeconds: source.refreshIntervalSeconds, timeoutMs: source.timeoutMs,
    concurrencyGroup: source.concurrencyGroup,
  };
  if (!parseSourceDefinition(result).success) throw new ServiceUnavailableException('SOURCE_DEFINITION_UNAVAILABLE');
  return result;
}

/** Only persisted, immutable data enters read paths. Freshness is a projection. */
export function publicSnapshot(row: SourceSnapshot, now = new Date()) {
  if (sha256(canonicalJson(row.data)) !== row.contentHash) throw new ServiceUnavailableException('SOURCE_SNAPSHOT_UNAVAILABLE');
  const state = row.freshnessState === 'fresh' && row.validDataCreatedAt
    && now.getTime() >= row.validDataCreatedAt.getTime() + row.staleAfterSeconds * 1000 ? 'stale' : row.freshnessState;
  const result = {
    protocolVersion: row.protocolVersion, snapshotId: row.snapshotId,
    sourceDefinitionId: row.sourceDefinitionId, schemaVersion: row.schemaVersion,
    connectorVersion: row.connectorVersion, createdAt: row.createdAt.toISOString(),
    ...(row.sourceTimestamp ? { sourceTimestamp: row.sourceTimestamp.toISOString() } : {}),
    freshness: { state, staleAfterSeconds: row.staleAfterSeconds }, data: row.data as JsonValue,
    ...(row.errorCode ? { error: { code: row.errorCode, message: 'Source refresh failed; inspect the recorded error code.', retryable: row.retryable } } : {}),
  };
  if (!parseSourceSnapshot(result).success) throw new ServiceUnavailableException('SOURCE_SNAPSHOT_UNAVAILABLE');
  return { ...result, revision: row.revision, contentHash: row.contentHash, definitionVersion: row.definitionVersion };
}

@Injectable()
export class SourceReadService {
  constructor(private readonly prisma: PrismaService) {}
  async list() {
    const sources = await this.prisma.sourceDefinition.findMany({ orderBy: { createdAt: 'asc' }, take: 1000, include: { latestSnapshot: true } });
    return sources.map(source => this.project(source));
  }
  async read(id: string) {
    const source = await this.prisma.sourceDefinition.findUnique({ where: { sourceDefinitionId: id }, include: { latestSnapshot: true } });
    if (!source) throw new NotFoundException('SOURCE_NOT_FOUND');
    return this.project(source);
  }
  async snapshot(id: string, snapshotId: string) {
    const row = await this.prisma.sourceSnapshot.findFirst({ where: { sourceDefinitionId: id, snapshotId } });
    if (!row) throw new NotFoundException('SOURCE_SNAPSHOT_NOT_FOUND');
    return publicSnapshot(row);
  }
  private project(source: SourceDefinition & { latestSnapshot: SourceSnapshot | null }) {
    return { definition: publicDefinition(source), enabled: source.enabled,
      state: { nextRefreshAt: source.nextRefreshAt.toISOString(), lastAttemptAt: source.lastAttemptAt?.toISOString() ?? null,
        lastSuccessAt: source.lastSuccessAt?.toISOString() ?? null, consecutiveFailures: source.consecutiveFailures,
        circuitOpenUntil: source.circuitOpenUntil?.toISOString() ?? null },
      snapshot: source.latestSnapshot ? publicSnapshot(source.latestSnapshot) : null };
  }
}
