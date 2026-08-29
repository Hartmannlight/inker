import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { assessScreenCompatibility } from '@inker/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { PublicationPersistenceService } from '../publications/publication-persistence.service';
import { canonicalJson, publicationArtifacts, sha256 } from '../publications/publication-content';
import { PublishService } from '../publications/publish.service';
import { PlaybackService } from '../playback/playback.service';
import { sqliteWrite } from '../sources/source-writes';
import { resolveDeviceConfiguration } from '../device-platform/device-configuration';

type Assignment =
  | { kind: 'none' }
  | { kind: 'screen'; publicationRevisionId: string }
  | { kind: 'screen'; screenId: number; expectedUpdatedAt: string }
  | { kind: 'playlist'; playlistRevisionId: string };

function input(value: unknown): { expectedDesiredRevisionId: string | null; expectedPlaybackVersion: number; assignment: Assignment } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid content assignment');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['version', 'expectedDesiredRevisionId', 'expectedPlaybackVersion', 'assignment'].includes(key)) ||
    body.version !== 1 || !(body.expectedDesiredRevisionId === null || typeof body.expectedDesiredRevisionId === 'string') ||
    !Number.isSafeInteger(body.expectedPlaybackVersion) || Number(body.expectedPlaybackVersion) < 0 || !body.assignment || typeof body.assignment !== 'object' || Array.isArray(body.assignment))
    throw new BadRequestException('Invalid content assignment');
  const assignment = body.assignment as Record<string, unknown>;
  if (assignment.kind === 'none' && Object.keys(assignment).length === 1) return { expectedDesiredRevisionId: body.expectedDesiredRevisionId, expectedPlaybackVersion: Number(body.expectedPlaybackVersion), assignment: { kind: 'none' } };
  if (assignment.kind === 'screen' && Object.keys(assignment).length === 2 && typeof assignment.publicationRevisionId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(assignment.publicationRevisionId))
    return { expectedDesiredRevisionId: body.expectedDesiredRevisionId, expectedPlaybackVersion: Number(body.expectedPlaybackVersion), assignment: { kind: 'screen', publicationRevisionId: assignment.publicationRevisionId } };
  if (assignment.kind === 'screen' && Object.keys(assignment).length === 3 && Number.isSafeInteger(assignment.screenId) && Number(assignment.screenId) > 0 &&
    typeof assignment.expectedUpdatedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(assignment.expectedUpdatedAt) && Number.isFinite(Date.parse(assignment.expectedUpdatedAt)))
    return { expectedDesiredRevisionId: body.expectedDesiredRevisionId, expectedPlaybackVersion: Number(body.expectedPlaybackVersion), assignment: { kind: 'screen', screenId: Number(assignment.screenId), expectedUpdatedAt: assignment.expectedUpdatedAt } };
  if (assignment.kind === 'playlist' && Object.keys(assignment).length === 2 && typeof assignment.playlistRevisionId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(assignment.playlistRevisionId))
    return { expectedDesiredRevisionId: body.expectedDesiredRevisionId, expectedPlaybackVersion: Number(body.expectedPlaybackVersion), assignment: { kind: 'playlist', playlistRevisionId: assignment.playlistRevisionId } };
  throw new BadRequestException('Invalid content assignment');
}

@Injectable()
export class ContentAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publications: PublicationPersistenceService,
    private readonly playback: PlaybackService,
    private readonly publisher: PublishService,
  ) {}

  async assign(deviceId: number, body: unknown) {
    const command = input(body);
    if (!Number.isSafeInteger(deviceId) || deviceId < 1) throw new BadRequestException('Invalid device');
    const preparedScreen = command.assignment.kind === 'screen' && 'screenId' in command.assignment
      ? await this.publisher.snapshotDraft(command.assignment)
      : null;
    return sqliteWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE devices SET id = id WHERE id = ${deviceId}`;
      const device = await tx.device.findFirst({ where: { id: deviceId, isActive: true }, include: { publicationState: true, playbackState: true } });
      if (!device) throw new NotFoundException('Target device not found');
      const desired = device.publicationState?.desiredPublicationRevisionId ?? null;
      const active = device.playbackState && ['running', 'paused'].includes(device.playbackState.status);
      // A transport retry observes the post-command revision. It is still safe
      // only when it requests precisely the state already committed.
      if (command.assignment.kind === 'none' && desired === null && !active)
        return { kind: 'none' as const, publicationRevisionId: null, playlistRevisionId: null };
      if (command.assignment.kind === 'screen' && !active) {
        if ('publicationRevisionId' in command.assignment && desired === command.assignment.publicationRevisionId)
          return { kind: 'screen' as const, publicationRevisionId: desired, playlistRevisionId: null };
        if (preparedScreen && desired) {
          const current = await tx.publicationRevision.findUnique({ where: { publicationRevisionId: desired } });
          if (current?.contentHash === sha256(canonicalJson(preparedScreen.content)))
            return { kind: 'screen' as const, publicationRevisionId: desired, playlistRevisionId: null };
        }
      }
      if (command.assignment.kind === 'playlist' && active && device.playbackState?.playlistRevisionId === command.assignment.playlistRevisionId)
        return { kind: 'playlist' as const, publicationRevisionId: null, playlistRevisionId: command.assignment.playlistRevisionId };
      if (desired !== command.expectedDesiredRevisionId || (device.playbackState?.version ?? 0) !== command.expectedPlaybackVersion)
        throw new ConflictException('Content assignment conflict');
      if (active) await this.playback.executeInTransaction(tx, deviceId, { version: 1, idempotencyKey: randomUUID(), expectedVersion: device.playbackState!.version,
        expectedDesiredSequence: device.publicationState?.desiredSequence ?? device.presentationRevision, action: 'stop' });
      if (command.assignment.kind === 'none') {
        await this.publications.clearDesiredRevision(deviceId, tx);
        await tx.device.update({ where: { id: deviceId }, data: { playlistId: null } });
        return { kind: 'none' as const, publicationRevisionId: null, playlistRevisionId: null };
      }
      if (command.assignment.kind === 'screen') {
        const revision = 'publicationRevisionId' in command.assignment
          ? await tx.publicationRevision.findUnique({ where: { publicationRevisionId: command.assignment.publicationRevisionId } })
          : await this.publishScreenDraft(tx, command.assignment.screenId, command.assignment.expectedUpdatedAt, preparedScreen!);
        if (!revision) throw new NotFoundException('Publication revision not found');
        publicationArtifacts(revision);
        await this.publications.setDesiredRevision(deviceId, revision.publicationRevisionId, tx);
        await tx.device.update({ where: { id: deviceId }, data: { playlistId: null } });
        return { kind: 'screen' as const, publicationRevisionId: revision.publicationRevisionId, playlistRevisionId: null };
      }
      const playlist = await tx.publishedPlaylist.findUnique({ where: { id: command.assignment.playlistRevisionId } });
      if (!playlist) throw new NotFoundException('Playlist revision not found');
      const stoppedVersion = active ? device.playbackState!.version + 1 : device.playbackState?.version ?? 0;
      const result = await this.playback.executeInTransaction(tx, deviceId, { version: 1, idempotencyKey: randomUUID(), expectedVersion: stoppedVersion,
        expectedDesiredSequence: device.publicationState?.desiredSequence ?? device.presentationRevision, action: 'start', playlistRevisionId: playlist.id });
      await tx.device.update({ where: { id: deviceId }, data: { playlistId: playlist.playlistId } });
      return { kind: 'playlist' as const, publicationRevisionId: null, playlistRevisionId: playlist.id, playback: result };
    }));
  }

  /** Read-only picker data; it deliberately exposes no publication artifacts. */
  async read(deviceId: number) {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, isActive: true },
      include: { publicationState: true, playbackState: true, profile: true, deliveryPolicy: true },
    });
    if (!device) throw new NotFoundException('Target device not found');
    const targetDisplay = resolveDeviceConfiguration(device.profile, device.deliveryPolicy, device.capabilitiesOverride).capabilities.display;
    const target = { width: targetDisplay.width, height: targetDisplay.height, renderFormats: targetDisplay.renderFormats, backgroundColor: targetDisplay.backgroundColor ?? '#ffffff' };
    const [screens, publishedPlaylists] = await Promise.all([
      this.prisma.screen.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: { id: true, name: true, updatedAt: true, width: true, height: true },
      }),
      this.prisma.publishedPlaylist.findMany({
        orderBy: { publishedAt: 'desc' },
        take: 100,
      }),
    ]);
    const playlists = await this.prisma.playlist.findMany({
      where: { id: { in: publishedPlaylists.map(playlist => playlist.playlistId) } },
      select: { id: true, name: true },
    });
    const names = new Map(playlists.map(playlist => [playlist.id, playlist.name]));
    return {
      current: {
        desiredPublicationRevisionId: device.publicationState?.desiredPublicationRevisionId ?? null,
        playbackVersion: device.playbackState?.version ?? 0,
        playlistRevisionId: ['running', 'paused'].includes(device.playbackState?.status ?? '')
          ? device.playbackState?.playlistRevisionId ?? null
          : null,
      },
      target: { width: target.width, height: target.height, renderFormats: target.renderFormats, backgroundColor: target.backgroundColor },
      screens: screens.map(screen => {
        const compatibility = assessScreenCompatibility({ width: screen.width, height: screen.height, format: screen.width && screen.height ? 'png' : null }, target);
        return { ...screen, updatedAt: screen.updatedAt.toISOString(), compatibility };
      }).sort((left, right) => {
        const rank = { exact: 0, adaptable: 1, risky: 2, unknown: 3 } as const;
        return rank[left.compatibility.kind] - rank[right.compatibility.kind] || right.updatedAt.localeCompare(left.updatedAt);
      }),
      playlists: publishedPlaylists.flatMap(playlist => {
        const name = names.get(playlist.playlistId);
        return name ? [{
        playlistRevisionId: playlist.id,
        playlistId: playlist.playlistId,
        name,
        revision: playlist.revision,
        publishedAt: playlist.publishedAt.toISOString(),
        }] : [];
      }),
    };
  }

  private async publishScreenDraft(tx: Prisma.TransactionClient, screenId: number, expectedUpdatedAt: string, prepared: NonNullable<Awaited<ReturnType<PublishService['snapshotDraft']>>>) {
    const screen = await tx.screen.findUnique({ where: { id: screenId }, select: { updatedAt: true, imageUrl: true } });
    if (!screen) throw new NotFoundException('Draft screen not found');
    if (screen.updatedAt.toISOString() !== expectedUpdatedAt || screen.imageUrl !== prepared.imageUrl)
      throw new ConflictException('Draft changed; reload before assigning');
    const contentHash = sha256(canonicalJson(prepared.content));
    const reusable = await tx.publicationRevision.findFirst({ where: { contentHash }, orderBy: { publishedAt: 'desc' } });
    if (reusable) return reusable;
    return (await this.publications.createPublication({
      publicationKey: `screen-assignment-${randomUUID()}`,
      protocolVersion: '1.0',
      content: prepared.content as unknown as Prisma.InputJsonValue,
      contentHash,
    }, tx)).revision;
  }
}
