import { describe, expect, it } from 'bun:test';
import type { PublicationRevision } from '@prisma/client';
import sharp from 'sharp';
import { DynamicDesignArtifactService } from './dynamic-design-artifact.service';
import { canonicalJson, sha256 } from '../publications/publication-content';
import type { RenderTarget } from '../render-cache/render-input';

function revision(content: PublicationRevision['content']): PublicationRevision {
  return {
    publicationId: 'publication-1', publicationRevisionId: 'revision-1', revision: 1,
    protocolVersion: '1.0', content, contentHash: sha256(canonicalJson(content)),
    publishedAt: new Date('2026-08-30T20:00:00.000Z'), createdAt: new Date('2026-08-30T20:00:00.000Z'),
  };
}

describe('DynamicDesignArtifactService', () => {
  it('renders a new publication only from its immutable recipe, even after the draft changes', async () => {
    const source = await sharp({ create: { width: 480, height: 480, channels: 3, background: '#000000' } }).png().toBuffer();
    const prisma = {
      screenDesign: { findUnique: async () => { throw new Error('must not read mutable draft'); } },
      publishedPlaylistEntry: { findFirst: async () => { throw new Error('must not infer provenance'); } },
    };
    const renderer = {
      renderPublishedDesign: async (design: any, context: any) => {
        expect(design.name).toBe('Frozen');
        expect(context).toMatchObject({ foregroundColor: '#ff9838', backgroundColor: '#000000' });
        return source;
      },
    };
    const service = new DynamicDesignArtifactService(prisma as any, renderer as any);
    const content = { schemaVersion: 1, image: { png: source.toString('base64'), width: 480, height: 480, sha256: sha256(source) },
      designSnapshot: { version: 1, id: 3, name: 'Frozen', width: 480, height: 480, background: '#ffffff', widgets: [] } };
    const artifact = await service.render({
      id: 1, battery: null, wifi: null, name: 'LCD', firmwareVersion: null, macAddress: null,
      configuration: { displayControl: { foregroundColor: '#ff9838', backgroundColor: '#000000' } },
    }, revision(content), target());

    expect(artifact).toMatchObject({ width: 480, height: 480, colorSpace: 'rgb', bitDepth: 16 });
  });

  it('resolves a legacy playlist publication back to its unchanged design and applies the device theme', async () => {
    const prisma = {
      publishedPlaylistEntry: { findFirst: async () => ({ itemId: 7 }) },
      playlistItem: { findUnique: async () => ({
        createdAt: new Date('2026-08-30T18:00:00.000Z'), screenDesignId: 3,
        screenDesign: { updatedAt: new Date('2026-08-30T19:00:00.000Z') },
      }) },
      screenDesign: { findUnique: async () => ({ updatedAt: new Date('2026-08-30T19:00:00.000Z'), width: 480, height: 480 }) },
    };
    const source = await sharp({ create: { width: 480, height: 480, channels: 3, background: '#000000' } }).png().toBuffer();
    const renderer = { renderPublishedDesign: async () => { throw new Error('not a snapshot'); }, renderScreenDesign: async (...args: unknown[]) => {
      expect(args[0]).toBe(3);
      expect(args[1]).toMatchObject({ foregroundColor: '#ff9838', backgroundColor: '#000000' });
      expect(args[2]).toBe('preview');
      return source;
    } };
    const service = new DynamicDesignArtifactService(prisma as any, renderer as any);
    const content = { schemaVersion: 1, image: { png: Buffer.from('old').toString('base64'), width: 480, height: 480, sha256: sha256(Buffer.from('old')) } };
    const artifact = await service.render({
      id: 1, battery: null, wifi: null, name: 'LCD', firmwareVersion: null, macAddress: null,
      configuration: { displayControl: { foregroundColor: '#ff9838', backgroundColor: '#000000' } },
    }, revision(content), target());

    expect(artifact).toMatchObject({ width: 480, height: 480, colorSpace: 'rgb', bitDepth: 16, rotation: 0 });
  });

  it('keeps the immutable image when the legacy source design changed after publication', async () => {
    const prisma = {
      publishedPlaylistEntry: { findFirst: async () => ({ itemId: 7 }) },
      playlistItem: { findUnique: async () => ({
        createdAt: new Date('2026-08-30T18:00:00.000Z'), screenDesignId: 3,
        screenDesign: { updatedAt: new Date('2026-08-30T21:00:00.000Z') },
      }) },
      screenDesign: { findUnique: async () => null },
    };
    const renderer = { renderPublishedDesign: async () => { throw new Error('must not render'); }, renderScreenDesign: async () => { throw new Error('must not render'); } };
    const service = new DynamicDesignArtifactService(prisma as any, renderer as any);
    expect(await service.render({
      id: 1, battery: null, wifi: null, name: 'LCD', firmwareVersion: null, macAddress: null, configuration: {},
    }, revision({ schemaVersion: 1 }), target())).toBeUndefined();
  });
});

function target(): RenderTarget {
  return { profileId: 'esp32-touch-reference-480x480', width: 480, height: 480, colorSpace: 'rgb', bitDepth: 16,
    rotation: 0, format: 'png', scaling: 'contain', backgroundColor: '#ffffff', safeArea: { top: 0, right: 0, bottom: 0, left: 0 } };
}
