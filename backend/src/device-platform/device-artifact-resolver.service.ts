import { Injectable, NotAcceptableException } from '@nestjs/common';
import type { Prisma, PublicationRevision } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { publicationArtifacts, type PublishedArtifact } from '../publications/publication-content';
import { RenderCacheService } from '../render-cache/render-cache.service';
import { targetFor, type RenderTarget } from '../render-cache/render-input';
import { resolveDeviceConfiguration, type ResolvedDeviceConfiguration } from './device-configuration';
import { DynamicDesignArtifactService } from './dynamic-design-artifact.service';

type Database = Prisma.TransactionClient | PrismaService;
export type ArtifactDevice = Prisma.DeviceGetPayload<{ include: { profile: true; deliveryPolicy: true } }>;

export interface ResolvedDeviceArtifact {
  configuration: ResolvedDeviceConfiguration;
  target: RenderTarget;
  revision: PublicationRevision;
  artifact: PublishedArtifact;
  fallback: boolean;
  rendererVersion?: string;
}

function matchesTarget(artifact: PublishedArtifact, target: RenderTarget): boolean {
  return artifact.format === target.format && artifact.mimeType === ({ png: 'image/png', jpeg: 'image/jpeg', bmp1: 'image/bmp' } as const)[target.format]
    && artifact.width === target.width && artifact.height === target.height
    && artifact.colorSpace === target.colorSpace && artifact.bitDepth === target.bitDepth
    && artifact.rotation === target.rotation;
}

/**
 * The only authority for turning one desired publication into the bytes a
 * particular device receives. Every transport and admin preview consumes this
 * result so they cannot silently select different publication artifacts.
 */
@Injectable()
export class DeviceArtifactResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RenderCacheService,
    private readonly dynamicDesigns: DynamicDesignArtifactService,
  ) {}

  async resolve(
    device: ArtifactDevice,
    desired: PublicationRevision,
    database: Database = this.prisma,
    observeCache = true,
  ): Promise<ResolvedDeviceArtifact> {
    const configuration = resolveDeviceConfiguration(device.profile, device.deliveryPolicy, device.capabilitiesOverride);
    const target = targetFor(configuration);
    const cached = await this.cache.read(device, desired, database as Prisma.TransactionClient, observeCache);
    const dynamic = await this.dynamicDesigns.render(device, desired, target);
    const revision = dynamic ? desired : cached?.revision ?? desired;
    const candidates = dynamic ? [dynamic] : cached ? [cached.artifact] : publicationArtifacts(revision);
    const artifact = candidates.find(candidate => matchesTarget(candidate, target));
    if (!artifact) throw new NotAcceptableException('No compatible published artifact for the device render target');
    return {
      configuration,
      target,
      revision,
      artifact,
      fallback: dynamic ? false : cached?.fallback ?? false,
      ...(dynamic ? { rendererVersion: 'dynamic-device-design-v1' } : cached?.rendererVersion ? { rendererVersion: cached.rendererVersion } : {}),
    };
  }
}
