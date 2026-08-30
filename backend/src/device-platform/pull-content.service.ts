import { Injectable, NotAcceptableException, NotFoundException, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { type PresentationManifest } from '@inker/contracts';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProfileResolverService } from './profile-resolver.service';
import { DeliveryPolicyRegistry } from './delivery-policy.registry';
import { TransportAdapterRegistry } from './transport-adapter.registry';
import { publicationAllowedActions, publicationArtifacts } from '../publications/publication-content';
import { PullLastSeenService } from './pull-last-seen.service';
import { RenderCacheService } from '../render-cache/render-cache.service';
import { TimerService } from '../timers/timer.service';
import { timerFeedResult } from '../timers/timer-feed';

type PullDevice = Prisma.DeviceGetPayload<{ include: { profile: true; deliveryPolicy: true } }>;

@Injectable()
export class PullContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfileResolverService,
    private readonly policies: DeliveryPolicyRegistry,
    private readonly transports: TransportAdapterRegistry,
    private readonly lastSeen: PullLastSeenService,
    @Optional() private readonly cache?: RenderCacheService,
    @Optional() private readonly timers?: TimerService,
  ) {}

  async read(device: PullDevice, includeTimers = true) {
    const { configuration, hints } = this.resolve(device);
    // A successfully authenticated pull is presence, even while the device has
    // no content assigned yet (that request intentionally ends in a 404).
    this.lastSeen.observe(device, hints.telemetryIntervalSeconds);
    const state = await this.prisma.devicePublicationState.findUnique({
      where: { deviceId: device.id }, include: { desiredRevision: true },
    });
    const desired = state?.desiredRevision;
    if (!desired) throw new NotFoundException('No published device content');
    const cached = await this.cache?.read(device, desired);
    const revision = cached?.revision ?? desired;
    // Do not serialize arbitrary snapshot fields, DB entities, URLs or parser diagnostics.
    const artifacts = cached ? [cached.artifact] : publicationArtifacts(revision);
    const display = configuration.capabilities.display;
    const candidates = artifacts.filter((artifact) =>
      display.mimeTypes.includes(artifact.mimeType) && display.width === artifact.width && display.height === artifact.height &&
      display.colorSpace === artifact.colorSpace && display.bitDepth === artifact.bitDepth && display.rotation === artifact.rotation);
    const artifact = display.renderFormats.flatMap((format) => candidates.filter((candidate) => candidate.format === format))[0];
    if (!artifact) throw new NotAcceptableException('No compatible published artifact');
    const allowedActions = cached && !cached.fallback && revision.publicationRevisionId === desired.publicationRevisionId
      ? publicationAllowedActions(revision) : [];
    const timerState = includeTimers && this.timers
      ? timerFeedResult(await this.timers.listForAuthenticatedDevice(device.id)) : undefined;

    const variantId = `${artifact.format}-${artifact.width}x${artifact.height}-${artifact.bitDepth}-${artifact.rotation}`;
    const contentTag = createHash('sha256').update(JSON.stringify([
      '1.0', revision.publicationId, revision.publicationRevisionId, revision.revision,
      configuration.profile.profileId, variantId, artifact.sha256,
      // Revoking rights on fallback must invalidate an authorized manifest even
      // when its previously rendered image and revision remain identical.
      ...(allowedActions.length ? [allowedActions] : []),
      ...(timerState ? [timerState.etag] : []),
    ])).digest('hex');
    const artifactEtag = `"${artifact.sha256}"`;
    const manifest: PresentationManifest = {
      protocolVersion: '1.0', manifestId: contentTag,
      publicationId: revision.publicationId, revision: String(revision.revision),
      profileId: configuration.profile.profileId, variantId,
      generatedAt: revision.publishedAt.toISOString(),
      artifacts: [{ artifactId: artifact.sha256, role: 'primary',
        url: `/api/v1/device-content/artifacts/${artifact.sha256}`,
        mimeType: artifact.mimeType, sizeBytes: artifact.bytes.length, sha256: artifact.sha256, etag: artifactEtag }],
      refresh: { refreshAfterSeconds: hints.refreshAfterSeconds },
      allowedActions,
      ...(timerState ? { timerState: timerState.feed } : {}),
      ...(cached?.fallback ? { fallbackRevision: String(revision.revision) } : {}),
      metadata: { desiredRevision: String(desired.revision), fallback: cached?.fallback ?? false,
        ...(cached ? { rendererVersion: cached.rendererVersion } : {}),
        ...(display.eInk ? { eInk: { fullRefreshRequired: true,
          ...(display.eInk.fullRefreshAfterUpdates ? { fullRefreshAfterUpdates: display.eInk.fullRefreshAfterUpdates } : {}) } } : {}) },
    };
    // A weak content validator deliberately excludes out-of-band delivery hints.
    return { manifest, etag: `W/"${contentTag}"`, artifact, artifactEtag,
      deliveryMode: configuration.deliveryPolicy.mode, hints };
  }

  private resolve(device: PullDevice) {
    try {
      const configuration = this.profiles.resolvePersisted(device);
      const policy = this.policies.get(configuration.deliveryPolicy.mode);
      // Pull is an explicit fallback transport. The policy's primary transport
      // may still be WebSocket for immediate invalidation.
      if (!configuration.capabilities.transport.modes.includes('http-pull')) throw new Error();
      const adapter = this.transports.get('http-pull');
      if (adapter.pullProtocolVersion !== '1.0' || !policy.pullHints) throw new Error();
      return { configuration, hints: policy.pullHints(configuration.capabilities, configuration.deliveryPolicy) };
    } catch {
      throw new NotAcceptableException('Device configuration does not support this pull protocol');
    }
  }
}
