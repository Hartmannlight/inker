import { BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject, Observable, filter } from 'rxjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type DeviceEventType =
  | 'screen:updated'
  | 'screen:deleted'
  | 'playlist:updated'
  | 'playlist:deleted'
  | 'screen_design:updated'
  | 'screen_design:deleted'
  | 'device:refresh';

export interface DeviceEvent {
  type: DeviceEventType;
  payload: {
    id?: number;
    deviceIds?: number[];
    playlistId?: number;
    screenId?: number;
    screenDesignId?: number;
    timestamp: number;
  };
}

@Injectable()
export class EventsService implements OnModuleDestroy {
  private events$ = new Subject<DeviceEvent>();

  constructor(private prisma: PrismaService) {}

  /**
   * Cleanup the Subject when the module is destroyed to prevent memory leaks
   */
  onModuleDestroy() {
    this.events$.complete();
  }

  /**
   * Emit an event to all connected clients
   */
  emit(event: DeviceEvent): void {
    this.events$.next(event);
  }

  /**
   * Get observable stream of events
   */
  getEventStream(): Observable<DeviceEvent> {
    return this.events$.asObservable();
  }

  /**
   * Get events filtered for specific device IDs
   */
  getEventsForDevices(deviceIds: number[]): Observable<DeviceEvent> {
    return this.events$.pipe(
      filter((event) => {
        // If event has specific deviceIds, check if any match
        if (event.payload.deviceIds && event.payload.deviceIds.length > 0) {
          return event.payload.deviceIds.some((id) => deviceIds.includes(id));
        }
        // Otherwise, pass all events (client will filter based on their playlists/screens)
        return true;
      }),
    );
  }

  /**
   * Notify devices when a screen is updated
   * Finds all devices that have this screen in their playlist
   */
  async notifyScreenUpdate(screenId: number, tx?: Prisma.TransactionClient): Promise<void> {
    this.assertIds([screenId]);
    if (!tx) return this.prisma.$transaction(t => this.notifyScreenUpdate(screenId, t));
    // Find all playlists containing this screen
    const playlistItems = await tx.playlistItem.findMany({
      where: { screenId },
      include: {
        playlist: {
          include: {
            devices: {
              select: { id: true },
            },
          },
        },
      },
    });

    // Collect all device IDs that need to be notified
    const deviceIds = new Set<number>();
    for (const item of playlistItems) {
      for (const device of item.playlist.devices) {
        deviceIds.add(device.id);
      }
    }

    const deviceIdsArray = Array.from(deviceIds);

    if (deviceIdsArray.length > 0) {
      // Set refreshPending flag on all affected devices
      await tx.device.updateMany({
        where: { id: { in: deviceIdsArray } },
        data: { refreshPending: true },
      });

    }

    await this.persist(tx, {
      type: 'screen:updated',
      payload: {
        screenId,
        deviceIds: deviceIdsArray,
        timestamp: Date.now(),
      },
    });
  }

  /**
   * Notify devices when a playlist is updated
   */
  async notifyPlaylistUpdate(playlistId: number, tx?: Prisma.TransactionClient): Promise<void> {
    this.assertIds([playlistId]);
    if (!tx) return this.prisma.$transaction(t => this.notifyPlaylistUpdate(playlistId, t));
    // Find all devices using this playlist
    const devices = await tx.device.findMany({
      where: { playlistId },
      select: { id: true },
    });

    const deviceIds = devices.map((d) => d.id);

    if (deviceIds.length > 0) {
      // Set refreshPending flag on all affected devices
      await tx.device.updateMany({
        where: { id: { in: deviceIds } },
        data: { refreshPending: true },
      });

    }

    await this.persist(tx, {
      type: 'playlist:updated',
      payload: {
        playlistId,
        deviceIds,
        timestamp: Date.now(),
      },
    });
  }

  /**
   * Notify devices when a screen design is updated
   * @returns The number of devices that were notified
   */
  async notifyScreenDesignUpdate(screenDesignId: number, tx?: Prisma.TransactionClient): Promise<number> {
    this.assertIds([screenDesignId]);
    if (!tx) return this.prisma.$transaction(t => this.notifyScreenDesignUpdate(screenDesignId, t));
    // Find all playlists containing this screen design
    const playlistItems = await tx.playlistItem.findMany({
      where: { screenDesignId },
      include: {
        playlist: {
          include: {
            devices: {
              select: { id: true },
            },
          },
        },
      },
    });

    // Collect all device IDs
    const deviceIds = new Set<number>();
    for (const item of playlistItems) {
      for (const device of item.playlist.devices) {
        deviceIds.add(device.id);
      }
    }

    // Also find devices with direct screen design assignments
    const directAssignments = await tx.deviceScreenAssignment.findMany({
      where: { screenDesignId },
      select: { deviceId: true },
    });

    for (const assignment of directAssignments) {
      deviceIds.add(assignment.deviceId);
    }

    const deviceIdsArray = Array.from(deviceIds);

    if (deviceIdsArray.length > 0) {
      // Set refreshPending flag on all affected devices
      await tx.device.updateMany({
        where: { id: { in: deviceIdsArray } },
        data: { refreshPending: true },
      });


    }

    await this.persist(tx, {
      type: 'screen_design:updated',
      payload: {
        screenDesignId,
        deviceIds: deviceIdsArray,
        timestamp: Date.now(),
      },
    });

    return deviceIdsArray.length;
  }

  /**
   * Notify specific devices to refresh
   */
  async notifyDevicesRefresh(deviceIds: number[], tx?: Prisma.TransactionClient): Promise<void> {
    this.assertIds(deviceIds);
    if (!deviceIds.length) return;
    if (!tx) return this.prisma.$transaction(t => this.notifyDevicesRefresh(deviceIds, t));
    if (deviceIds.length > 0) {
      // Set refreshPending flag on specified devices
      await tx.device.updateMany({
        where: { id: { in: deviceIds } },
        data: { refreshPending: true },
      });

    }

    // A batched request still has one revision counter per actual device.
    for (const deviceId of new Set(deviceIds)) {
      await this.persist(tx, {
        type: 'device:refresh',
        payload: { deviceIds: [deviceId], timestamp: Date.now() },
      });
    }
  }

  private async persist(tx: Prisma.TransactionClient, event: DeviceEvent) {
    const aggregateType = event.payload.screenId ? 'Screen' : event.payload.playlistId ? 'Playlist' : event.payload.screenDesignId ? 'ScreenDesign' : 'Device';
    const aggregateId = String(event.payload.screenId ?? event.payload.playlistId ?? event.payload.screenDesignId ?? [...new Set(event.payload.deviceIds)].sort((a, b) => a - b).join(','));
    const aggregate = await tx.outboxAggregate.upsert({
      where: { aggregateType_aggregateId: { aggregateType, aggregateId } },
      create: { aggregateType, aggregateId, revision: 1 }, update: { revision: { increment: 1 } },
    });
    const occurredAt = new Date(event.payload.timestamp);
    await tx.outboxEvent.create({ data: { eventType: event.type, aggregateType, aggregateId,
      aggregateRevision: String(aggregate.revision), payloadVersion: 1,
      payload: event.payload as Prisma.InputJsonValue, occurredAt, availableAt: occurredAt } });
  }

  private assertIds(ids: number[]) {
    if (!Array.isArray(ids) || ids.length > 1024 || !ids.every(id => Number.isSafeInteger(id) && id > 0)) {
      throw new BadRequestException('Invalid notification identifiers');
    }
  }
}
