import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parseDeviceServerMessage, type WebDisplayManifest } from '@inker/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { resolveDeviceConfiguration } from './device-configuration';
import type { DeliveryContext } from '../events/outbox.types';
import { DeviceArtifactResolverService } from './device-artifact-resolver.service';
import { PullArtifactLeaseService } from './pull-artifact-lease.service';
import { readDisplayControl } from './display-control';

@Injectable()
export class PresentationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly artifacts: DeviceArtifactResolverService,
    private readonly leases: PullArtifactLeaseService,
  ) {}

  async getForDevice(deviceId: number, context?: DeliveryContext): Promise<WebDisplayManifest> {
    if (!context) return this.build(deviceId, this.prisma);
    context.signal.throwIfAborted();
    const cached = await this.prisma.outboxDelivery.findUniqueOrThrow({ where: { deliveryId: context.deliveryId } });
    if (cached.deviceId !== deviceId) throw new Error('OUTBOX_DEVICE_MISMATCH');
    if (cached.presentation) return this.validate(cached.presentation);
    return this.prisma.$transaction(async tx => {
      // Technical receipt only. Neither initial delivery nor retries publish,
      // rotate playlists, change device state or increment a domain revision.
      await tx.$executeRaw`UPDATE outbox_deliveries SET device_id = device_id WHERE delivery_id = ${context.deliveryId} AND device_id = ${deviceId}`;
      const receipt = await tx.outboxDelivery.findUniqueOrThrow({ where: { deliveryId: context.deliveryId } });
      if (receipt.deviceId !== deviceId) throw new Error('OUTBOX_DEVICE_MISMATCH');
      if (receipt.presentation) return this.validate(receipt.presentation);
      const presentation = await this.build(deviceId, tx);
      context.signal.throwIfAborted();
      await tx.outboxDelivery.update({ where: { deliveryId: context.deliveryId },
        data: { presentation: presentation as unknown as Prisma.InputJsonValue } });
      return presentation;
    });
  }

  async artifact(deviceId: number, hash: string) {
      const current = await this.read(deviceId, this.prisma);
      const artifact = current.artifact?.sha256 === hash ? current.artifact : this.leases.read(deviceId, hash);
      if (!artifact) throw new NotFoundException('Published artifact not found');
      return artifact;
  }

  /**
   * Admin-only callers use the same immutable artifact selected for delivery.
   * This is deliberately read-only: previewing must not render, publish, or
   * advance a device's desired/acknowledged state.
   */
  async preview(deviceId: number) {
    const { artifact } = await this.read(deviceId, this.prisma);
    if (!artifact) throw new NotFoundException('No published device content');
    return artifact;
  }

  private async read(deviceId: number, database: Prisma.TransactionClient) {
    const device = await database.device.findUnique({ where: { id: deviceId }, include: {
      profile: true, deliveryPolicy: true, publicationState: { include: { desiredRevision: true } },
    } });
    if (!device || !device.externalId) throw new NotFoundException('Display device not found');
    const desired = device.publicationState?.desiredRevision;
    if (!desired) {
      const configuration = resolveDeviceConfiguration(device.profile, device.deliveryPolicy, device.capabilitiesOverride);
      return { device, display: configuration.capabilities.display, revision: undefined, artifact: undefined };
    }
    const resolved = await this.artifacts.resolve(device, desired, database, false);
    const display = resolved.configuration.capabilities.display;
    const background = display.colorSpace === 'rgb' ? readDisplayControl(device.configuration).backgroundColor : '#ffffff';
    return { device, display, background, revision: resolved.revision, artifact: resolved.artifact };
  }

  private async build(deviceId: number, database: Prisma.TransactionClient): Promise<WebDisplayManifest> {
    const { device, display, background = '#ffffff', revision, artifact } = await this.read(deviceId, database);
    if (artifact) this.leases.issue(device.id, artifact);
    return this.validate({
      deviceId: device.id, externalId: device.externalId,
      // Pointer and assignment sequence come from the same state row/read.
      // Reading the immutable referenced content needs no interactive transaction.
      revision: device.publicationState?.desiredSequence ?? device.presentationRevision,
      renderRevision: device.renderRevision,
      generatedAt: (revision?.publishedAt ?? device.createdAt).toISOString(),
      nextTransitionAt: null,
      content: { kind: 'image', fit: 'contain', background,
        title: revision ? 'Published content' : 'No publication assigned',
        url: artifact ? `/api/web-displays/${device.externalId}/artifacts/${artifact.sha256}` : '/assets/publication-unassigned.svg' },
      viewport: { width: display.width, height: display.height },
    });
  }

  private validate(presentation: unknown): WebDisplayManifest {
    const parsed = parseDeviceServerMessage({ protocolVersion: '1.0', type: 'presentation.changed', presentation });
    if (!parsed.success || parsed.data.type !== 'presentation.changed') throw new Error('OUTBOX_INVALID_PRESENTATION');
    return parsed.data.presentation;
  }
}
