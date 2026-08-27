import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PresentationManifest } from './presentation.types';
import { resolveDeviceConfiguration } from './device-configuration';
import { Prisma } from '@prisma/client';
import type { DeliveryContext } from '../events/outbox.types';
import { parseDeviceServerMessage } from '@inker/contracts';

@Injectable()
export class PresentationService {
  constructor(private readonly prisma: PrismaService) {}

  async getForDevice(deviceId: number, context?: DeliveryContext): Promise<PresentationManifest> {
    if (!context) return this.build(deviceId, this.prisma);
    context.signal.throwIfAborted();
    return this.prisma.$transaction(async tx => {
      // Acquire the SQLite writer lock before reading; simultaneous adapter
      // processes prepare exactly one revision/snapshot for this delivery.
      await tx.outboxDelivery.update({ where: { deliveryId: context.deliveryId, deviceId }, data: { deviceId } });
      const receipt = await tx.outboxDelivery.findUniqueOrThrow({ where: { deliveryId: context.deliveryId } });
      if (receipt.deviceId !== deviceId) throw new Error('OUTBOX_DEVICE_MISMATCH');
      if (receipt.presentation) return receipt.presentation as unknown as PresentationManifest;
      const presentation = await this.build(deviceId, tx);
      // Validate URL/field secrecy before persisting a retry snapshot, not only
      // at the later WebSocket boundary.
      if (!parseDeviceServerMessage({ protocolVersion: '1.0', type: 'presentation.changed', presentation }).success) {
        throw new Error('OUTBOX_INVALID_PRESENTATION');
      }
      context.signal.throwIfAborted();
      await tx.outboxDelivery.update({ where: { deliveryId: receipt.deliveryId },
        data: { presentation: presentation as unknown as Prisma.InputJsonValue } });
      return presentation;
    });
  }

  private async build(deviceId: number, database: Prisma.TransactionClient): Promise<PresentationManifest> {
    const device = await database.device.findUnique({
      where: { id: deviceId },
      include: {
        profile: true,
        deliveryPolicy: true,
        playlist: {
          include: {
            items: {
              include: {
                screen: true,
                screenDesign: true,
                pluginInstance: { include: { plugin: true } },
              },
              orderBy: { order: 'asc' },
            },
          },
        },
      },
    });
    if (!device || !device.externalId) throw new NotFoundException('Display device not found');

    const now = new Date();
    const items = device.playlist?.items ?? [];
    let item: (typeof items)[number] | null = null;
    let startedAt = device.screenStartedAt ?? now;
    let nextTransitionAt: Date | null = null;

    if (items.length > 0) {
      const ids = items.map((candidate) => this.itemId(candidate));
      let index = device.lastScreenId ? ids.indexOf(device.lastScreenId) : -1;
      if (index < 0) {
        index = 0;
        startedAt = now;
      } else {
        let elapsed = Math.max(0, now.getTime() - startedAt.getTime());
        const cycleMs = items.reduce((sum, candidate) => sum + this.durationMs(candidate.duration), 0);
        if (cycleMs > 0 && elapsed > cycleMs) elapsed %= cycleMs;
        while (elapsed >= this.durationMs(items[index].duration)) {
          elapsed -= this.durationMs(items[index].duration);
          index = (index + 1) % items.length;
        }
        startedAt = new Date(now.getTime() - elapsed);
      }
      item = items[index];
      nextTransitionAt = new Date(startedAt.getTime() + this.durationMs(item.duration));
    }

    const currentId = item ? this.itemId(item) : null;
    const updated = await database.device.update({
      where: { id: device.id },
      data: {
        lastScreenId: currentId,
        screenStartedAt: item ? startedAt : null,
        presentationRevision: { increment: 1 },
      },
      select: { presentationRevision: true },
    });

    const content = this.contentFor(item, device, updated.presentationRevision);
    const viewport = device.profile && device.deliveryPolicy
      ? resolveDeviceConfiguration(
          device.profile,
          device.deliveryPolicy,
          device.capabilitiesOverride,
        ).capabilities.display
      : { width: device.width || 1920, height: device.height || 1080 };
    return {
      deviceId: device.id,
      externalId: device.externalId,
      revision: updated.presentationRevision,
      generatedAt: now.toISOString(),
      nextTransitionAt: nextTransitionAt?.toISOString() ?? null,
      content,
      viewport: {
        width: viewport.width,
        height: viewport.height,
      },
    };
  }

  private durationMs(duration: number | null): number {
    return Math.max(1, duration ?? 60) * 1000;
  }

  private itemId(item: any): string {
    if (item.screenDesign) return `design-${item.screenDesign.id}`;
    if (item.screen) return `screen-${item.screen.id}`;
    if (item.pluginInstance) return `plugin-${item.pluginInstance.id}`;
    return `item-${item.id}`;
  }

  private contentFor(item: any | null, device: any, revision: number): PresentationManifest['content'] {
    if (item?.screen) {
      return {
        kind: 'image',
        url: item.screen.imageUrl,
        title: item.screen.name,
        fit: 'contain',
        background: '#000000',
      };
    }
    if (item?.screenDesign) {
      const query = new URLSearchParams({
        mode: 'preview',
        t: String(revision),
        deviceName: device.name,
      });
      return {
        kind: 'image',
        url: `/api/device-images/design/${item.screenDesign.id}?${query.toString()}`,
        title: item.screenDesign.name,
        fit: 'contain',
        background: item.screenDesign.background || '#ffffff',
      };
    }
    if (item?.pluginInstance) {
      return {
        kind: 'image',
        url: `/api/plugins/instances/${item.pluginInstance.id}/render?mode=preview&t=${revision}`,
        title: item.pluginInstance.name || item.pluginInstance.plugin?.name || 'Plugin',
        fit: 'contain',
        background: '#ffffff',
      };
    }
    return {
      kind: 'image',
      url: `/api/device-images/device/${device.id}?t=${revision}`,
      title: 'Inker',
      fit: 'contain',
      background: '#ffffff',
    };
  }
}
