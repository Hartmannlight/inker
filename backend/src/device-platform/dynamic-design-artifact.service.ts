import { Injectable } from '@nestjs/common';
import type { Device, PublicationRevision } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { publicationDesignSnapshot, publicationDynamicDesign, type PublishedArtifact, type PublishedDesignSnapshot } from '../publications/publication-content';
import { canonicalJson, sha256 } from '../common/utils/content-hash.util';
import { renderSnapshot } from '../render-cache/snapshot-renderer';
import type { RenderTarget } from '../render-cache/render-input';
import { ScreenRendererService } from '../screen-designer/services/screen-renderer.service';
import { readDisplayControl } from './display-control';

type DynamicDevice = Pick<Device, 'id' | 'battery' | 'wifi' | 'name' | 'firmwareVersion' | 'macAddress' | 'configuration'>;
type DynamicDesign = { screenDesignId: number; expectedUpdatedAt: string; refreshSeconds: number };

/** Renders the complete published clock design, preserving fonts and all combined widgets. */
@Injectable()
export class DynamicDesignArtifactService {
  private readonly minuteCache = new Map<string, PublishedArtifact>();

  constructor(private readonly prisma: PrismaService, private readonly renderer: ScreenRendererService) {}

  async render(device: DynamicDevice, revision: PublicationRevision, target: RenderTarget): Promise<PublishedArtifact | undefined> {
    const snapshot = publicationDesignSnapshot(revision);
    const dynamic = snapshot ? this.snapshotDescriptor(snapshot) : await this.resolveDynamicDesign(revision);
    if (!dynamic) return undefined;
    const minute = Math.floor(Date.now() / dynamic.refreshSeconds / 1000);
    const theme = target.colorSpace === 'rgb' ? readDisplayControl(device.configuration) : undefined;
    const telemetryKey = [device.battery ?? '', device.wifi ?? '', device.name, device.firmwareVersion ?? '', device.macAddress ?? ''].join('|');
    const themeKey = theme ? `${theme.foregroundColor}:${theme.backgroundColor}` : '';
    const key = `${revision.publicationRevisionId}:${device.id}:${minute}:${telemetryKey}:${sha256(canonicalJson(target))}:${themeKey}`;
    const cached = this.minuteCache.get(key);
    if (cached) return cached;

    const design = snapshot ?? await this.prisma.screenDesign.findUnique({
      where: { id: dynamic.screenDesignId }, select: { updatedAt: true, width: true, height: true },
    });
    if (!design || (!snapshot && 'updatedAt' in design && design.updatedAt.toISOString() !== dynamic.expectedUpdatedAt)) {
      return undefined;
    }
    const context = {
      ...(device.battery !== null ? { battery: device.battery } : {}),
      ...(device.wifi !== null ? { wifi: device.wifi } : {}),
      deviceName: device.name,
      ...(device.firmwareVersion ? { firmwareVersion: device.firmwareVersion } : {}),
      ...(device.macAddress ? { macAddress: device.macAddress } : {}),
      ...(theme ? { foregroundColor: theme.foregroundColor, backgroundColor: theme.backgroundColor } : {}),
    };
    const sourceBytes = snapshot
      ? await this.renderer.renderPublishedDesign(snapshot, context)
      : await this.renderer.renderScreenDesign(dynamic.screenDesignId, context, 'preview', 'png');
    const content = { schemaVersion: 1, image: {
      png: sourceBytes.toString('base64'), width: design.width, height: design.height, sha256: sha256(sourceBytes),
    } };
    const sourceRevision = { ...revision, content, contentHash: sha256(canonicalJson(content)) };
    const artifact = await renderSnapshot(sourceRevision, target);
    if (this.minuteCache.size >= 128) this.minuteCache.clear();
    this.minuteCache.set(key, artifact);
    return artifact;
  }

  private snapshotDescriptor(snapshot: PublishedDesignSnapshot): DynamicDesign {
    return { screenDesignId: snapshot.id, expectedUpdatedAt: 'immutable', refreshSeconds: 60 };
  }

  /**
   * Revisions published before every design carried dynamicDesign metadata can
   * still be resolved through their immutable playlist entry. We only use the
   * live design when both the item and design predate the publication; edited or
   * deleted drafts safely fall back to the stored publication image.
   */
  private async resolveDynamicDesign(revision: PublicationRevision): Promise<DynamicDesign | undefined> {
    const declared = publicationDynamicDesign(revision);
    if (declared) return declared;
    const entry = await this.prisma.publishedPlaylistEntry.findFirst({
      where: { publicationRevisionId: revision.publicationRevisionId },
      select: { itemId: true },
    });
    if (!entry) return undefined;
    const item = await this.prisma.playlistItem.findUnique({
      where: { id: entry.itemId },
      select: {
        createdAt: true,
        screenDesignId: true,
        screenDesign: { select: { updatedAt: true } },
      },
    });
    if (!item?.screenDesignId || !item.screenDesign || item.createdAt > revision.publishedAt || item.screenDesign.updatedAt > revision.publishedAt) {
      return undefined;
    }
    return {
      screenDesignId: item.screenDesignId,
      expectedUpdatedAt: item.screenDesign.updatedAt.toISOString(),
      refreshSeconds: 60,
    };
  }
}
