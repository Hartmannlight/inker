import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlaylistDto } from './dto/create-playlist.dto';
import { UpdatePlaylistDto } from './dto/update-playlist.dto';
import { AddPlaylistItemDto } from './dto/add-playlist-item.dto';
import { UpdatePlaylistItemDto } from './dto/update-playlist-item.dto';
import { wrapPaginatedResponse } from '../common/utils/response.util';
import { EventsService } from '../events/events.service';
import type { Prisma } from '@prisma/client';
import {
  materializePlaylistItems,
  parsePlaylistTargets,
  type PlaylistTargetInput,
} from './playlist-targets';

function getJsonNumber(
  value: Prisma.JsonValue,
  key: string,
  fallback: number,
): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fallback;
  }

  const candidate = value[key];
  const parsed = typeof candidate === 'string' || typeof candidate === 'number'
    ? Number(candidate)
    : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface ProjectablePlaylistItem {
  id: number;
  duration: number | null;
  order: number;
  screen: null | {
    id: number;
    name: string;
    description: string | null;
    thumbnailUrl: string | null;
    imageUrl: string;
  };
  screenDesign: null | {
    id: number;
    name: string;
    description: string | null;
  };
  pluginInstance: null | {
    id: number;
    name: string | null;
    settings: Prisma.JsonValue;
    plugin: null | { name: string; description: string | null };
  };
  recipeBinding: null | {
    recipeBindingId: string;
    name: string | null;
    settings: Prisma.JsonValue;
    definition: { name: string; description: string | null };
  };
}

function projectPlaylistItem(item: ProjectablePlaylistItem) {
  if (item.recipeBinding) {
    const previewUrl = `/api/recipes/bindings/${item.recipeBinding.recipeBindingId}/render?mode=preview`;
    return {
      itemId: item.id, id: `recipe:${item.recipeBinding.recipeBindingId}`,
      screenId: `recipe:${item.recipeBinding.recipeBindingId}`,
      name: item.recipeBinding.name || item.recipeBinding.definition.name,
      description: item.recipeBinding.definition.description,
      thumbnailUrl: previewUrl, imageUrl: previewUrl, duration: item.duration, order: item.order,
      isDesigned: false, isPlugin: true, isRecipe: true,
      width: getJsonNumber(item.recipeBinding.settings, 'screen_width', 800),
      height: getJsonNumber(item.recipeBinding.settings, 'screen_height', 480),
    };
  }
  if (item.pluginInstance) {
    const previewUrl = `/api/plugins/instances/${item.pluginInstance.id}/render?mode=preview`;
    return {
      itemId: item.id,
      id: `plugin-${item.pluginInstance.id}`,
      screenId: `plugin-${item.pluginInstance.id}`,
      name: item.pluginInstance.name || item.pluginInstance.plugin?.name || 'Plugin',
      description: item.pluginInstance.plugin?.description,
      thumbnailUrl: previewUrl,
      imageUrl: previewUrl,
      duration: item.duration,
      order: item.order,
      isDesigned: false,
      isPlugin: true,
      width: getJsonNumber(item.pluginInstance.settings, 'screen_width', 800),
      height: getJsonNumber(item.pluginInstance.settings, 'screen_height', 480),
    };
  }
  if (item.screenDesign) {
    const previewUrl = `/screen-designs/${item.screenDesign.id}/preview`;
    return {
      itemId: item.id,
      id: `design-${item.screenDesign.id}`,
      screenId: `design-${item.screenDesign.id}`,
      name: item.screenDesign.name,
      description: item.screenDesign.description,
      thumbnailUrl: previewUrl,
      imageUrl: previewUrl,
      duration: item.duration,
      order: item.order,
      isDesigned: true,
    };
  }
  if (item.screen) {
    return {
      itemId: item.id,
      id: item.screen.id,
      screenId: String(item.screen.id),
      name: item.screen.name,
      description: item.screen.description,
      thumbnailUrl: item.screen.thumbnailUrl,
      imageUrl: item.screen.imageUrl,
      duration: item.duration,
      order: item.order,
      isDesigned: false,
    };
  }
  return null;
}

@Injectable()
export class PlaylistsService {
  private readonly logger = new Logger(PlaylistsService.name);

  constructor(
    private prisma: PrismaService,
    private eventsService: EventsService,
  ) {}

  private async createPlaylistItems(
    database: Prisma.TransactionClient,
    playlistId: number,
    screens: readonly PlaylistTargetInput[],
  ): Promise<number> {
    const parsed = parsePlaylistTargets(screens);
    parsed.invalid.forEach((source) => this.logger.warn(`Invalid playlist target: ${source}`));

    const [designs, regularScreens, plugins, recipes] = await Promise.all([
      parsed.designIds.length
        ? database.screenDesign.findMany({ where: { id: { in: parsed.designIds } }, select: { id: true } })
        : Promise.resolve([]),
      parsed.regularIds.length
        ? database.screen.findMany({ where: { id: { in: parsed.regularIds } }, select: { id: true } })
        : Promise.resolve([]),
      parsed.pluginIds.length
        ? database.pluginInstance.findMany({ where: { id: { in: parsed.pluginIds } }, select: { id: true } })
        : Promise.resolve([]),
      parsed.recipeIds.length
        ? database.recipeBinding.findMany({ where: { recipeBindingId: { in: parsed.recipeIds } }, select: { recipeBindingId: true } })
        : Promise.resolve([]),
    ]);
    const result = materializePlaylistItems(playlistId, parsed, {
      designIds: new Set(designs.map(({ id }) => id)),
      regularIds: new Set(regularScreens.map(({ id }) => id)),
      pluginIds: new Set(plugins.map(({ id }) => id)),
      recipeIds: new Set(recipes.map(({ recipeBindingId }) => recipeBindingId)),
    });
    result.missing.forEach(({ kind, id }) => this.logger.warn(`Playlist ${kind} target not found: ${id}`));

    if (result.items.length) {
      await database.playlistItem.createMany({ data: result.items });
    }
    return result.items.length;
  }

  /**
   * Create a new playlist
   */
  async create(createPlaylistDto: CreatePlaylistDto) {
    const { screens, ...playlistData } = createPlaylistDto;

    const playlist = await this.prisma.playlist.create({
      data: {
        name: playlistData.name,
        description: playlistData.description,
        isActive: playlistData.isActive ?? true,
        advanceOnTap: playlistData.advanceOnTap ?? false,
      },
      include: {
        items: {
          include: {
            screen: true,
            screenDesign: true,
            pluginInstance: { include: { plugin: true } },
            recipeBinding: { include: { definition: true } },
          },
          orderBy: {
            order: 'asc',
          },
        },
      },
    });

    // Handle screens if provided
    if (screens && screens.length > 0) {
      const createdItemCount = await this.createPlaylistItems(this.prisma, playlist.id, screens);

      // Refetch playlist with items
      const updatedPlaylist = await this.prisma.playlist.findUnique({
        where: { id: playlist.id },
        include: {
          items: {
            include: {
              screen: true,
              screenDesign: true,
              pluginInstance: { include: { plugin: true } },
              recipeBinding: { include: { definition: true } },
            },
            orderBy: {
              order: 'asc',
            },
          },
        },
      });

      this.logger.log(`Playlist created: ${playlist.name} with ${createdItemCount} screens`);

      return updatedPlaylist;
    }

    this.logger.log(`Playlist created: ${playlist.name}`);

    return playlist;
  }

  /**
   * Find all playlists with pagination
   */
  async findAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [playlists, total] = await Promise.all([
      this.prisma.playlist.findMany({
        include: {
          _count: {
            select: {
              items: true,
              devices: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.playlist.count(),
    ]);

    return wrapPaginatedResponse(playlists, total, page, limit);
  }

  /**
   * Find one playlist by ID
   */
  async findOne(id: number) {
    const playlist = await this.prisma.playlist.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            screen: {
              include: {
                model: true,
              },
            },
            screenDesign: true,
            pluginInstance: {
              include: { plugin: true },
            },
            recipeBinding: { include: { definition: true } },
          },
          orderBy: {
            order: 'asc',
          },
        },
        devices: {
          select: {
            id: true,
            name: true,
            macAddress: true,
            width: true,
            height: true,
          },
        },
      },
    });

    if (!playlist) {
      throw new NotFoundException('Playlist not found');
    }

    // Transform items to screens array for frontend compatibility
    const screens = playlist.items.map(projectPlaylistItem).filter((item) => item !== null);

    return {
      ...playlist,
      screens,
    };
  }

  /**
   * Update playlist
   */
  async update(id: number, updatePlaylistDto: UpdatePlaylistDto) {
    return this.prisma.$transaction(async (tx) => {
      const playlist = await tx.playlist.findUnique({
        where: { id },
        include: {
          _count: {
            select: { devices: true },
          },
        },
      });

      if (!playlist) {
        throw new NotFoundException('Playlist not found');
      }

      // Prevent deactivating a playlist that has devices assigned
      if (updatePlaylistDto.isActive === false && playlist._count.devices > 0) {
        throw new BadRequestException(
          `Cannot deactivate playlist - it is assigned to ${playlist._count.devices} device(s). Unassign all devices first.`,
        );
      }

      // Extract screens for separate handling
      const { screens, ...playlistData } = updatePlaylistDto;

      // Update playlist basic data
      const updatedPlaylist = await tx.playlist.update({
        where: { id },
        data: {
          name: playlistData.name,
          description: playlistData.description,
          isActive: playlistData.isActive,
          advanceOnTap: playlistData.advanceOnTap,
        },
        include: {
          items: {
            include: {
              screen: true,
            },
            orderBy: {
              order: 'asc',
            },
          },
        },
      });

      // Handle screens update if provided
      if (screens !== undefined) {
        // Delete all existing items
        await tx.playlistItem.deleteMany({
          where: { playlistId: id },
        });

        // Add new items using the shared batch path to avoid N+1 queries.
        if (screens.length > 0) {
          await this.createPlaylistItems(tx, id, screens);
        }

        // Refetch playlist with updated items and transform to screens array
        const updatedPlaylistWithItems = await tx.playlist.findUnique({
          where: { id },
          include: {
            items: {
              include: {
                screen: true,
                screenDesign: true,
                pluginInstance: { include: { plugin: true } },
                recipeBinding: { include: { definition: true } },
              },
              orderBy: {
                order: 'asc',
              },
            },
          },
        });

        if (!updatedPlaylistWithItems) {
          throw new NotFoundException('Playlist not found after update');
        }

        // Transform items to screens array
        const transformedScreens = updatedPlaylistWithItems.items
          .map(projectPlaylistItem)
          .filter((item) => item !== null);

        // Notify devices that use this playlist to refresh
        await this.eventsService.notifyPlaylistUpdate(id, tx);

        return {
          ...updatedPlaylistWithItems,
          screens: transformedScreens,
        };
      }

      this.logger.log(`Playlist updated: ${updatedPlaylist.name}`);

      // Notify devices that use this playlist to refresh
      await this.eventsService.notifyPlaylistUpdate(id, tx);

      return updatedPlaylist;
    });
  }

  /**
   * Delete playlist
   * @param force - If true, unassign all devices first and then delete
   */
  async remove(id: number, force = false) {
    return this.prisma.$transaction(async (tx) => {
      const playlist = await tx.playlist.findUnique({
        where: { id },
        include: {
          devices: {
            select: { id: true },
          },
          _count: {
            select: {
              devices: true,
            },
          },
        },
      });

      if (!playlist) {
        throw new NotFoundException('Playlist not found');
      }

      // Check if playlist is in use
      if (playlist._count.devices > 0) {
        if (force) {
          // Unassign all devices first
          const deviceIds = playlist.devices.map((d) => d.id);
          await tx.device.updateMany({
            where: { playlistId: id },
            data: {
              playlistId: null,
              refreshPending: true, // Trigger refresh to show default screen
            },
          });
          this.logger.log(
            `Force delete: Unassigned ${deviceIds.length} device(s) from playlist ${playlist.name}`,
          );

          // Notify devices to refresh
          await this.eventsService.notifyDevicesRefresh(deviceIds, tx);
        } else {
          throw new BadRequestException(
            `Cannot delete playlist - it is assigned to ${playlist._count.devices} device(s). Use force=true to unassign devices and delete.`,
          );
        }
      }

      await tx.playlist.delete({
        where: { id },
      });

      this.logger.log(`Playlist deleted: ${playlist.name}`);

      return {
        message: 'Playlist deleted successfully',
        unassignedDevices: force ? playlist._count.devices : 0,
      };
    });
  }

  /**
   * Add item to playlist
   */
  async addItem(playlistId: number, addItemDto: AddPlaylistItemDto) {
    return this.prisma.$transaction(async (tx) => {
      const playlist = await tx.playlist.findUnique({
        where: { id: playlistId },
        include: {
          items: true,
        },
      });

      if (!playlist) {
        throw new NotFoundException('Playlist not found');
      }

      // Check if screen exists
      const screen = await tx.screen.findUnique({
        where: { id: addItemDto.screenId },
      });

      if (!screen) {
        throw new NotFoundException('Screen not found');
      }

      // Check if item already exists in playlist
      const existingItem = await tx.playlistItem.findFirst({
        where: {
          playlistId,
          screenId: addItemDto.screenId,
        },
      });

      if (existingItem) {
        throw new BadRequestException('Screen already in playlist');
      }

      // Determine order (append to end if not specified)
      const order =
        addItemDto.order !== undefined
          ? addItemDto.order
          : playlist.items.length;

      // Create playlist item
      const item = await tx.playlistItem.create({
        data: {
          playlistId,
          screenId: addItemDto.screenId,
          order,
          duration: addItemDto.duration === 0 ? null : addItemDto.duration ?? 60,
        },
        include: {
          screen: {
            include: {
              model: true,
            },
          },
        },
      });

      this.logger.log(
        `Screen ${screen.name} added to playlist ${playlist.name}`,
      );

      // Notify devices that use this playlist to refresh
      await this.eventsService.notifyPlaylistUpdate(playlistId, tx);

      return item;
    });
  }

  /**
   * Update playlist item
   */
  async updateItem(
    playlistId: number,
    itemId: number,
    updateItemDto: UpdatePlaylistItemDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const playlist = await tx.playlist.findUnique({
        where: { id: playlistId },
      });

      if (!playlist) {
        throw new NotFoundException('Playlist not found');
      }

      // Check if item exists
      const item = await tx.playlistItem.findUnique({
        where: { id: itemId },
      });

      if (!item || item.playlistId !== playlistId) {
        throw new NotFoundException('Playlist item not found');
      }

      // Update item
      const updatedItem = await tx.playlistItem.update({
        where: { id: itemId },
        data: {
          order: updateItemDto.order,
          duration: updateItemDto.duration === 0 ? null : updateItemDto.duration,
        },
        include: {
          screen: {
            include: {
              model: true,
            },
          },
        },
      });

      this.logger.log(`Playlist item ${itemId} updated`);

      // Notify devices that use this playlist to refresh
      await this.eventsService.notifyPlaylistUpdate(playlistId, tx);

      return updatedItem;
    });
  }

  /**
   * Remove item from playlist
   */
  async removeItem(playlistId: number, itemId: number) {
    return this.prisma.$transaction(async (tx) => {
      const playlist = await tx.playlist.findUnique({
        where: { id: playlistId },
      });

      if (!playlist) {
        throw new NotFoundException('Playlist not found');
      }

      // Check if item exists
      const item = await tx.playlistItem.findUnique({
        where: { id: itemId },
      });

      if (!item || item.playlistId !== playlistId) {
        throw new NotFoundException('Playlist item not found');
      }

      // Delete item
      await tx.playlistItem.delete({
        where: { id: itemId },
      });

      this.logger.log(`Playlist item ${itemId} removed from playlist ${playlistId}`);

      // Notify devices that use this playlist to refresh
      await this.eventsService.notifyPlaylistUpdate(playlistId, tx);

      return { message: 'Playlist item removed successfully' };
    });
  }

  /**
   * Reorder playlist items
   */
  async reorderItems(
    playlistId: number,
    itemOrders: { id: number; order: number }[],
  ) {
    return this.prisma.$transaction(async (tx) => {
      const playlist = await tx.playlist.findUnique({
        where: { id: playlistId },
      });

      if (!playlist) {
        throw new NotFoundException('Playlist not found');
      }

      // Update orders in transaction
      await Promise.all(
        itemOrders.map(({ id, order }) =>
          tx.playlistItem.update({
            where: { id },
            data: { order },
          }),
        ),
      );

      this.logger.log(`Playlist ${playlistId} items reordered`);

      // Notify devices that use this playlist to refresh
      await this.eventsService.notifyPlaylistUpdate(playlistId, tx);

      return { message: 'Playlist items reordered successfully' };
    });
  }
}
