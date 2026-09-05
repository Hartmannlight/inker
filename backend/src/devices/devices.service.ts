import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from '../events/events.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { generateToken } from '../common/utils/crypto.util';
import { Prisma } from '@prisma/client';
import { wrapPaginatedResponse } from '../common/utils/response.util';
import { serializeDevice, serializeDevices, isNewerVersion } from './entities/device.entity';
import { FirmwareService } from '../firmware/firmware.service';
import { DeliveryPolicyRegistry } from '../device-platform/delivery-policy.registry';
import type { DeviceCapabilitiesOverride, ResolvedDeviceConfiguration } from '../device-platform/device-configuration';
import { ProfileResolverService } from '../device-platform/profile-resolver.service';
import { TransportAdapterRegistry } from '../device-platform/transport-adapter.registry';
import { parseDisplayControlInput, readDisplayControl } from '../device-platform/display-control';
import type { DisplayControlDto } from './dto/display-control.dto';
import { RenderCacheService } from '../render-cache/render-cache.service';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private prisma: PrismaService,
    private eventsService: EventsService,
    private firmwareService: FirmwareService,
    private profileResolver: ProfileResolverService,
    private deliveryPolicies: DeliveryPolicyRegistry,
    private transportAdapters: TransportAdapterRegistry,
    @Optional() private renderCache?: RenderCacheService,
  ) {}

  /**
   * Create a new device with auto-generated API key
   * If MAC was previously blocked (deleted device), unblock it first
   */
  async create(createDeviceDto: CreateDeviceDto) {
    const resolved = await this.profileResolver.resolveForCreate(createDeviceDto);
    const adapter = this.adapterFor(resolved);
    if (createDeviceDto.deviceType && createDeviceDto.deviceType !== adapter.legacy.deviceType) {
      throw new BadRequestException('deviceType conflicts with the selected device profile');
    }
    const width = resolved.capabilities.display.width;
    const height = resolved.capabilities.display.height;
    const registration = adapter.prepareRegistration({ macAddress: createDeviceDto.macAddress });

    if (createDeviceDto.macAddress) {
      const existingDevice = await this.prisma.device.findUnique({
        where: { macAddress: createDeviceDto.macAddress },
      });
      if (existingDevice) {
        throw new BadRequestException('Device with this MAC address already exists');
      }
      await this.prisma.blockedDevice.deleteMany({
        where: { macAddress: createDeviceDto.macAddress },
      });
    }

    // Create device
    const device = await this.prisma.device.create({
      data: {
        name: createDeviceDto.name,
        deviceType: adapter.legacy.deviceType,
        transport: adapter.legacy.transport,
        externalId: registration.externalId,
        capabilities: resolved.capabilities as unknown as Prisma.InputJsonValue,
        configuration: {},
        telemetry: {},
        battery: null,
        wifi: null,
        profileId: resolved.profile.profileId,
        capabilitiesOverride: resolved.capabilitiesOverride as unknown as Prisma.InputJsonValue ?? undefined,
        deliveryPolicyId: resolved.deliveryPolicy.policyId,
        macAddress: createDeviceDto.macAddress ?? null,
        apiKey: registration.apiKey,
        playlistId: createDeviceDto.playlistId,
        width,
        height,
      },
      include: {
        profile: true,
        deliveryPolicy: true,
        playlist: {
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
        },
      },
    });

    this.logger.log(`Device created: ${device.name} (${adapter.adapterId})`);

    return serializeDevice(device);
  }

  /**
   * Find all devices with pagination
   */
  async findAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [devices, total] = await Promise.all([
      this.prisma.device.findMany({
        include: {

          playlist: {
            select: {
              id: true,
              name: true,
            },
          },
          profile: true,
          deliveryPolicy: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.device.count(),
    ]);

    return wrapPaginatedResponse(serializeDevices(devices), total, page, limit);
  }

  /**
   * Find one device by ID
   */
  async findOne(id: number) {
    const device = await this.prisma.device.findUnique({
      where: { id },
      include: {
        model: true,
        profile: true,
        deliveryPolicy: true,
        playlist: {
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
        },
        publicationState: {
          select: {
            desiredPublicationRevisionId: true,
            desiredSequence: true,
          },
        },
        playbackState: {
          select: {
            version: true,
            status: true,
            playlistRevisionId: true,
          },
        },
      },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    // Informational only: is there a newer stable firmware than the device's
    // current version? Inker never pushes OTA updates — this just drives a note
    // on the device detail page.
    const latestFirmware = await this.firmwareService.getLatestStableOrNull();
    const latestFirmwareVersion = latestFirmware?.version ?? null;
    const firmwareUpdateAvailable = isNewerVersion(
      latestFirmwareVersion,
      device.firmwareVersion,
    );

    return {
      ...serializeDevice(device),
      firmwareUpdateAvailable,
      latestFirmwareVersion: firmwareUpdateAvailable ? latestFirmwareVersion : null,
    };
  }

  /**
   * Update device
   */
  async update(id: number, updateDeviceDto: UpdateDeviceDto) {
    const device = await this.prisma.device.findUnique({
      where: { id },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    // Check if MAC address is being changed to an existing one
    if (updateDeviceDto.macAddress && updateDeviceDto.macAddress !== device.macAddress) {
      const existingDevice = await this.prisma.device.findUnique({
        where: { macAddress: updateDeviceDto.macAddress },
      });

      if (existingDevice) {
        throw new BadRequestException('Device with this MAC address already exists');
      }
    }

    // Check if playlist is being changed - trigger device refresh
    const playlistChanging = updateDeviceDto.playlistId !== undefined &&
      updateDeviceDto.playlistId !== device.playlistId;

    // A model/format change should also refresh the device so it fetches the new format.
    const modelChanging = updateDeviceDto.modelId !== undefined &&
      updateDeviceDto.modelId !== device.modelId;

    // If the model is being changed (e.g. switching og_png -> og_bmp for issue #31),
    // resolve it so we can sync the device's screen dimensions to the model's, unless
    // the caller passed explicit width/height overrides in the same request.
    let modelDimensions: { width?: number; height?: number } = {};
    if (updateDeviceDto.modelId !== undefined && updateDeviceDto.modelId !== device.modelId) {
      const model = await this.prisma.model.findUnique({
        where: { id: updateDeviceDto.modelId },
      });
      if (!model) {
        throw new BadRequestException('Model not found');
      }
      modelDimensions = {
        width: updateDeviceDto.width ?? model.width,
        height: updateDeviceDto.height ?? model.height,
      };
    }

    const profileId = updateDeviceDto.profileId ?? device.profileId;
    const deliveryPolicyId = updateDeviceDto.deliveryPolicyId ?? device.deliveryPolicyId;
    const currentResolved = await this.profileResolver.resolveForCreate({
      profileId: device.profileId,
      deliveryPolicyId: device.deliveryPolicyId,
      capabilitiesOverride: device.capabilitiesOverride,
    });
    const resolved = await this.profileResolver.resolveForCreate({
      profileId,
      deliveryPolicyId,
      capabilitiesOverride: updateDeviceDto.capabilitiesOverride ?? device.capabilitiesOverride,
      width: modelDimensions.width ?? updateDeviceDto.width,
      height: modelDimensions.height ?? updateDeviceDto.height,
    });
    const currentAdapter = this.adapterFor(currentResolved);
    const adapter = this.adapterFor(resolved);
    if (updateDeviceDto.profileId && adapter.adapterId !== currentAdapter.adapterId) {
      throw new BadRequestException(
        'A device profile cannot switch between legacy transport families in place',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedDevice = await tx.device.update({
        where: { id },
        data: {
          name: updateDeviceDto.name,
          macAddress: updateDeviceDto.macAddress,
          firmwareVersion: updateDeviceDto.firmwareVersion,
          playlistId: updateDeviceDto.playlistId,
          modelId: updateDeviceDto.modelId,
          isActive: updateDeviceDto.isActive,
          profileId,
          deliveryPolicyId,
          capabilitiesOverride: resolved.capabilitiesOverride as unknown as Prisma.InputJsonValue ?? undefined,
          capabilities: resolved.capabilities as unknown as Prisma.InputJsonValue,
          transport: adapter.legacy.transport,
          width: resolved.capabilities.display.width,
          height: resolved.capabilities.display.height,
          // Quiet hours / sleep schedule (undefined = no change, null = clear/disable)
          sleepStartAt: updateDeviceDto.sleepStartAt,
          sleepStopAt: updateDeviceDto.sleepStopAt,
          showSleepScreen: updateDeviceDto.showSleepScreen,
          // Set refreshPending if playlist or model/format changed to trigger immediate device refresh
          ...((playlistChanging || modelChanging) && { refreshPending: true }),
        },
        include: {
          profile: true,
          deliveryPolicy: true,
          playlist: {
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
          },
        },
      });

      this.logger.log(`Device updated: ${updatedDevice.name}`);

      // Notify device to refresh if playlist changed (including unassigned)
      if (playlistChanging) {
        await this.eventsService.notifyDevicesRefresh([id], tx);
        this.logger.log(`Device ${id} playlist changed - refresh notification sent`);
      }

      return serializeDevice(updatedDevice);
    });
  }

  async getDisplayControl(id: number) {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('Device not found');
    return readDisplayControl(device.configuration);
  }

  async updateDisplayTechnology(id: number, technology: 'lcd' | 'eink') {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('Device not found');
    if (device.deviceType !== 'web-display') {
      throw new BadRequestException('Display technology can only be selected for web-connected devices');
    }

    const base = await this.profileResolver.resolveForCreate({
      profileId: device.profileId,
      deliveryPolicyId: device.deliveryPolicyId,
    });
    if (technology === 'lcd' && base.capabilities.display.colorSpace !== 'rgb') {
      throw new BadRequestException('The selected device profile does not support LCD/color output');
    }
    const current = await this.profileResolver.resolveForCreate({
      profileId: device.profileId,
      deliveryPolicyId: device.deliveryPolicyId,
      capabilitiesOverride: device.capabilitiesOverride as DeviceCapabilitiesOverride | null,
    });
    const nextOverride = structuredClone(current.capabilitiesOverride ?? {}) as DeviceCapabilitiesOverride;
    const display = { ...(nextOverride.display ?? {}) };
    if (technology === 'eink') {
      display.colorSpace = 'monochrome';
      display.bitDepth = 1;
      display.eInk = { partialRefreshSupported: false };
    } else {
      delete display.colorSpace;
      delete display.bitDepth;
      delete display.eInk;
    }
    if (Object.keys(display).length) nextOverride.display = display;
    else delete nextOverride.display;

    const resolved = await this.profileResolver.resolveForCreate({
      profileId: device.profileId,
      deliveryPolicyId: device.deliveryPolicyId,
      capabilitiesOverride: nextOverride,
    });
    const updated = await this.prisma.$transaction(async tx => {
      const saved = await tx.device.update({
        where: { id },
        data: {
          capabilitiesOverride: nextOverride as unknown as Prisma.InputJsonValue,
          capabilities: resolved.capabilities as unknown as Prisma.InputJsonValue,
          width: resolved.capabilities.display.width,
          height: resolved.capabilities.display.height,
          refreshPending: true,
        },
        include: { profile: true, deliveryPolicy: true },
      });
      await this.eventsService.notifyDevicesRefresh([id], tx);
      return saved;
    });
    await this.renderCache?.request(id);
    return { technology, device: serializeDevice(updated) };
  }

  async updateDisplayControl(id: number, input: DisplayControlDto) {
    let displayControl;
    try {
      displayControl = parseDisplayControlInput(input);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid display control settings');
    }
    return this.prisma.$transaction(async (tx) => {
      const device = await tx.device.findUnique({ where: { id } });
      if (!device) throw new NotFoundException('Device not found');
      const capabilities = device.capabilities && typeof device.capabilities === 'object' && !Array.isArray(device.capabilities)
        ? device.capabilities as Record<string, unknown> : {};
      const display = capabilities.display && typeof capabilities.display === 'object' && !Array.isArray(capabilities.display)
        ? capabilities.display as Record<string, unknown> : {};
      if (display.colorSpace !== 'rgb') {
        throw new BadRequestException('Brightness controls are only available for LCD/RGB hardware devices');
      }
      const configuration = device.configuration && typeof device.configuration === 'object' && !Array.isArray(device.configuration)
        ? device.configuration as Record<string, unknown> : {};
      await tx.device.update({
        where: { id },
        data: {
          configuration: { ...configuration, displayControl } as unknown as Prisma.InputJsonValue,
          refreshPending: true,
        },
      });
      await this.eventsService.notifyDevicesRefresh([id], tx);
      return displayControl;
    });
  }

  /**
   * Delete device
   * Adds MAC address to blocked_devices to prevent auto-re-provisioning
   */
  async remove(id: number) {
    const device = await this.prisma.device.findUnique({
      where: { id },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    // Only pull/TRMNL devices auto-provision by MAC and therefore need blocking.
    if (device.macAddress) {
      await this.prisma.blockedDevice.upsert({
        where: { macAddress: device.macAddress },
        create: { macAddress: device.macAddress, reason: 'Deleted by admin' },
        update: { createdAt: new Date() },
      });
    }

    await this.prisma.device.delete({
      where: { id },
    });

    this.logger.log(`Device deleted: ${device.name} (${device.deviceType})`);

    return { message: 'Device deleted successfully' };
  }

  /**
   * Device polling endpoint - returns current screen to display
   * This is called by the device using its API key
   */
  async getDisplayContent(apiKey: string) {
    const device = await this.prisma.device.findUnique({
      where: { apiKey },
      include: {

        playlist: {
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
        },
      },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (!device.isActive) {
      throw new ForbiddenException('Device is inactive');
    }

    // Update last seen timestamp
    await this.prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });

    // If no playlist assigned, return default "Hello World" welcome screen
    if (!device.playlist || !device.playlist.items.length) {
      return {
        deviceId: device.id,
        deviceName: device.name,
        message: 'No playlist assigned - showing default welcome screen',
        screen: null,
        defaultContent: {
          type: 'welcome',
          title: 'Hello World',
          subtitle: 'This is inker!',
          message: 'Assign a playlist to this device to display your content',
        },
        refreshRate: device.refreshRate || 900,
      };
    }

    // Get current screen from playlist (simple rotation for now)
    // In production, you might want more sophisticated scheduling
    const currentIndex = Math.floor(Date.now() / 60000) % device.playlist.items.length;
    const currentItem = device.playlist.items[currentIndex];

    if (!currentItem.screen) {
      throw new NotFoundException('Current playlist item has no screen');
    }

    this.logger.debug(
      `Device ${device.name} polling - serving screen: ${currentItem.screen.name}`,
    );

    return {
      deviceId: device.id,
      deviceName: device.name,
      screen: {
        id: currentItem.screen.id,
        name: currentItem.screen.name,
        imageUrl: currentItem.screen.imageUrl,
        duration: currentItem.duration,
      },
      nextRefresh: currentItem.duration,
    };
  }

  /**
   * Regenerate API key for a device
   */
  async regenerateApiKey(id: number) {
    const device = await this.prisma.device.findUnique({
      where: { id },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    const newApiKey = this.generateApiKey();
    const updatedDevice = await this.prisma.device.update({
      where: { id },
      data: { apiKey: newApiKey },
    });

    this.logger.log(`API key regenerated for device: ${device.name}`);

    return {
      deviceId: updatedDevice.id,
      apiKey: updatedDevice.apiKey,
    };
  }

  /**
   * Generate a unique API key
   */
  private generateApiKey(): string {
    return generateToken(32);
  }

  private adapterFor(configuration: ResolvedDeviceConfiguration) {
    const policy = this.deliveryPolicies.get(configuration.deliveryPolicy.mode);
    return this.transportAdapters.get(policy.selectTransport(configuration.capabilities));
  }

  /**
   * Log device event
   */
  async logDeviceEvent(
    deviceId: number,
    level: string,
    message: string,
    metadata?: Prisma.InputJsonValue,
  ) {
    return this.prisma.deviceLog.create({
      data: {
        deviceId,
        level,
        message,
        metadata: metadata || {},
      },
    });
  }

  /**
   * Get device logs
   */
  async getDeviceLogs(deviceId: number) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    return this.prisma.deviceLog.findMany({
      where: { deviceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * Trigger device refresh
   * Sets refreshPending flag and emits SSE event to notify connected clients
   */
  async triggerRefresh(id: number) {
    const device = await this.prisma.device.findUnique({
      where: { id },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    // Persist the refresh flag and outbox intent atomically
    await this.eventsService.notifyDevicesRefresh([id]);

    this.logger.log(`Refresh triggered for device: ${device.name}`);

    return { message: 'Device refresh triggered', deviceId: id };
  }

  /**
   * Unassign playlist from device
   * Device will display the default "Hello World" welcome screen
   */
  async unassignPlaylist(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const device = await tx.device.findUnique({
        where: { id },
        include: {
          playlist: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      if (!device) {
        throw new NotFoundException('Device not found');
      }

      // Check if device has a playlist assigned
      if (!device.playlistId) {
        throw new BadRequestException('Device has no playlist assigned');
      }

      const previousPlaylist = device.playlist;

      // Unassign playlist and trigger refresh
      const updatedDevice = await tx.device.update({
        where: { id },
        data: {
          playlistId: null,
          refreshPending: true, // Trigger refresh to show default screen
        },
        include: {

        },
      });

      // Notify device to refresh (will now show the default welcome screen)
      await this.eventsService.notifyDevicesRefresh([id], tx);

      this.logger.log(
        `Playlist "${previousPlaylist?.name}" unassigned from device "${device.name}" - device will show default welcome screen`,
      );

      return {
        message: 'Playlist unassigned successfully',
        device: serializeDevice(updatedDevice),
        previousPlaylist: previousPlaylist
          ? { id: previousPlaylist.id, name: previousPlaylist.name }
          : null,
        displayContent: {
          type: 'welcome',
          title: 'Hello World',
          subtitle: 'This is inker!',
          message: 'Assign a playlist to this device to display your content',
        },
      };
    });
  }
}
