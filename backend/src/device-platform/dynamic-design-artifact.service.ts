import { Injectable } from '@nestjs/common';
import type { Device, PublicationRevision } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { publicationDynamicDesign, sha256, type PublishedArtifact } from '../publications/publication-content';
import { ScreenRendererService } from '../screen-designer/services/screen-renderer.service';

type DynamicDevice = Pick<Device, 'id' | 'battery' | 'wifi' | 'name' | 'firmwareVersion' | 'macAddress'>;
type DynamicDisplay = { colorSpace: 'monochrome' | 'grayscale' | 'rgb'; bitDepth: number; rotation: number };

/** Renders the complete published clock design, preserving fonts and all combined widgets. */
@Injectable()
export class DynamicDesignArtifactService {
  private readonly minuteCache = new Map<string, PublishedArtifact>();

  constructor(private readonly prisma: PrismaService, private readonly renderer: ScreenRendererService) {}

  async render(device: DynamicDevice, revision: PublicationRevision, display: DynamicDisplay): Promise<PublishedArtifact | undefined> {
    const dynamic = publicationDynamicDesign(revision);
    if (!dynamic) return undefined;
    const minute = Math.floor(Date.now() / dynamic.refreshSeconds / 1000);
    const telemetryKey = [device.battery ?? '', device.wifi ?? '', device.name, device.firmwareVersion ?? '', device.macAddress ?? ''].join('|');
    const key = `${revision.publicationRevisionId}:${device.id}:${minute}:${telemetryKey}:${display.colorSpace}:${display.bitDepth}:${display.rotation}`;
    const cached = this.minuteCache.get(key);
    if (cached) return cached;

    const design = await this.prisma.screenDesign.findUnique({
      where: { id: dynamic.screenDesignId }, select: { updatedAt: true, width: true, height: true },
    });
    if (!design || design.updatedAt.toISOString() !== dynamic.expectedUpdatedAt) {
      // Keep serving the immutable publication image if its source draft was edited later.
      return undefined;
    }
    const bytes = await this.renderer.renderScreenDesign(dynamic.screenDesignId, {
      ...(device.battery !== null ? { battery: device.battery } : {}),
      ...(device.wifi !== null ? { wifi: device.wifi } : {}),
      deviceName: device.name,
      ...(device.firmwareVersion ? { firmwareVersion: device.firmwareVersion } : {}),
      ...(device.macAddress ? { macAddress: device.macAddress } : {}),
    }, 'device', 'png');
    const artifact: PublishedArtifact = {
      format: 'png', mimeType: 'image/png', width: design.width, height: design.height,
      colorSpace: display.colorSpace, bitDepth: display.bitDepth, rotation: display.rotation,
      bytes, sha256: sha256(bytes),
    };
    if (this.minuteCache.size >= 128) this.minuteCache.clear();
    this.minuteCache.set(key, artifact);
    return artifact;
  }
}
