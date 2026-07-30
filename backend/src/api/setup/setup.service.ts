import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { generateToken } from '../../common/utils/crypto.util';
import { SetupScreenService } from './setup-screen.service';

/**
 * Known device model dimensions for /api/setup provisioning.
 * Maps model name to { width, height } defaults.
 */
const MODEL_DIMENSIONS: Record<string, { width: number; height: number }> = {
  og_png: { width: 800, height: 480 },
  og_bmp: { width: 800, height: 480 },
  large_png: { width: 1024, height: 758 },
  large_bmp: { width: 1024, height: 758 },
  small_png: { width: 400, height: 300 },
  small_bmp: { width: 400, height: 300 },
  medium_png: { width: 640, height: 384 },
  medium_bmp: { width: 640, height: 384 },
  trmnl_x: { width: 1872, height: 1404 },
};

/**
 * TRMNL firmware reports a short model code in its HTTP_MODEL header (e.g. "x" for the TRMNL X,
 * "og" for the original). Map those to Inker model names so a device is auto-linked to the right
 * model (and thus resolution + colour depth) on provisioning. Codes already matching an Inker
 * model name pass through unchanged.
 */
const DEVICE_MODEL_ALIASES: Record<string, string> = {
  x: 'trmnl_x',   // TRMNL X — 10.3", 1872x1404, 16-level grayscale
  og: 'og_png',   // TRMNL OG — 7.5", 800x480, 1-bit
};

/**
 * Device metrics from headers
 */
export interface DeviceMetrics {
  battery?: number;  // Battery percentage (0-100)
  wifi?: number;     // WiFi RSSI in dBm (e.g., -51)
}

@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private prisma: PrismaService,
    private setupScreenService: SetupScreenService,
  ) {}

  /**
   * Provision device using MAC address
   * Returns device UUID (API key) and configuration
   * Compatible with Ruby Inker setup endpoint
   *
   * @param macAddress - Device MAC address
   * @param firmwareVersion - Device firmware version (optional)
   * @param metrics - Device metrics (battery, wifi)
   * @param baseUrl - Dynamic base URL from request (e.g., "http://localhost:3002")
   * @param modelName - Device model name (optional, defaults to "og_png")
   */
  async provisionDevice(
    macAddress: string,
    firmwareVersion?: string,
    metrics?: DeviceMetrics,
    baseUrl?: string,
    modelName?: string,
    reportedWidth?: number,
    reportedHeight?: number,
  ) {
    // Validate MAC address format
    if (!this.isValidMacAddress(macAddress)) {
      throw new BadRequestException('Invalid MAC address format');
    }

    // If device was previously deleted/blocked, unblock it so it can re-provision
    await this.prisma.blockedDevice.deleteMany({
      where: { macAddress },
    });

    // Check if device already exists
    let device = await this.prisma.device.findUnique({
      where: { macAddress },
    });

    if (device) {
      // Device exists, update firmware version and metrics if provided
      const updateData: {
        firmwareVersion?: string;
        lastSeenAt: Date;
        battery?: number;
        wifi?: number;
      } = {
        lastSeenAt: new Date(),
      };

      if (firmwareVersion && firmwareVersion !== device.firmwareVersion) {
        updateData.firmwareVersion = firmwareVersion;
      }

      // Update battery if provided
      if (metrics?.battery !== undefined && !isNaN(metrics.battery)) {
        updateData.battery = metrics.battery;
      }

      // Update wifi RSSI if provided
      if (metrics?.wifi !== undefined && !isNaN(metrics.wifi)) {
        updateData.wifi = metrics.wifi;
      }

      device = await this.prisma.device.update({
        where: { id: device.id },
        data: updateData,
      });

      this.logger.log(
        `Device ${device.name} re-provisioned (MAC: ${macAddress}, battery: ${device.battery}%, wifi: ${device.wifi} dBm)`,
      );

      return this.buildSetupResponse(device, baseUrl);
    }

    // Device doesn't exist, create new one
    // Generate API key (UUID)
    const apiKey = generateToken(32);

    // Auto-detect the device's model + resolution from what its firmware reports (issue: TRMNL X
    // was defaulting to 800x480). The device's own reported width/height win; the model code links
    // it to an Inker model (resolution + colour depth).
    const resolved = await this.resolveDeviceModel(modelName, reportedWidth, reportedHeight);
    this.logger.log(
      `Provisioning ${macAddress}: model="${modelName ?? 'none'}" reported=${reportedWidth ?? '?'}x${reportedHeight ?? '?'} ` +
      `→ ${resolved.width}x${resolved.height}${resolved.modelId ? ` (modelId ${resolved.modelId})` : ''}`,
    );

    // Create new device
    device = await this.prisma.device.create({
      data: {
        name: `Device-${macAddress.slice(-8)}`,
        friendlyId: this.generateFriendlyId(),
        macAddress,
        apiKey,
        firmwareVersion,
        modelId: resolved.modelId ?? undefined,
        width: resolved.width,
        height: resolved.height,
        lastSeenAt: new Date(),
        refreshRate: 900, // 15 minutes default
        wifi: metrics?.wifi !== undefined && !isNaN(metrics.wifi) ? metrics.wifi : 0,
        battery: metrics?.battery !== undefined && !isNaN(metrics.battery) ? metrics.battery : 0,
      },
    });

    if (!device) {
      throw new BadRequestException('Failed to create device');
    }

    this.logger.log(
      `New device provisioned: ${device.name} (MAC: ${macAddress})`,
    );

    return this.buildSetupResponse(device, baseUrl);
  }

  /**
   * Resolve a provisioning device's model + resolution from what its firmware reports.
   *
   * Priority for dimensions: the device's reported width/height (most reliable) → the matched Inker
   * model's dimensions → the static dimension map → OG 800x480. The model code (e.g. "x") is mapped
   * to an Inker model name so the device is linked to a Model row (giving it the right colour depth).
   */
  private async resolveDeviceModel(
    modelCode?: string,
    reportedWidth?: number,
    reportedHeight?: number,
  ): Promise<{ modelId: number | null; width: number; height: number }> {
    let modelName: string | undefined;
    if (modelCode) {
      const lc = modelCode.toLowerCase();
      modelName = DEVICE_MODEL_ALIASES[lc] || (MODEL_DIMENSIONS[lc] ? lc : undefined);
    }

    const modelRow = modelName
      ? await this.prisma.model.findFirst({ where: { name: modelName } })
      : null;

    const dimFromMap = modelName ? MODEL_DIMENSIONS[modelName] : undefined;
    const validW = reportedWidth && reportedWidth > 0 ? reportedWidth : undefined;
    const validH = reportedHeight && reportedHeight > 0 ? reportedHeight : undefined;

    return {
      modelId: modelRow?.id ?? null,
      width: validW ?? modelRow?.width ?? dimFromMap?.width ?? MODEL_DIMENSIONS.og_png.width,
      height: validH ?? modelRow?.height ?? dimFromMap?.height ?? MODEL_DIMENSIONS.og_png.height,
    };
  }

  /**
   * Build setup response compatible with Ruby Inker format
   * Must match the exact format from firmware/setup.rb:
   * { api_key, friendly_id, image_url, message }
   */
  private buildSetupResponse(device: any, baseUrl?: string) {
    // Use dynamic URL from request, or fall back to environment/default
    const apiUrl = baseUrl || process.env.API_URL || 'http://localhost:3002';

    // Get the setup screen URL from the SetupScreenService
    const setupScreenUrl = this.setupScreenService.getSetupScreenUrl();

    return {
      status: 200,                      // Firmware 1.7.8 setup parser checks status == 200
      api_key: device.apiKey,           // CRITICAL: Must be 'api_key' not 'uuid'
      friendly_id: device.friendlyId,   // Friendly name for the device
      image_url: `${apiUrl}${setupScreenUrl}`,  // Setup screen image
      message: 'Welcome to Inker!',     // Welcome message
    };
  }

  /**
   * Validate MAC address format
   */
  private isValidMacAddress(mac: string): boolean {
    // Accept various MAC address formats:
    // - AA:BB:CC:DD:EE:FF
    // - AA-BB-CC-DD-EE-FF
    // - AABBCCDDEEFF
    const macRegex = /^([0-9A-Fa-f]{2}[:-]?){5}([0-9A-Fa-f]{2})$/;
    return macRegex.test(mac);
  }

  /**
   * Generate a friendly ID for device
   */
  private generateFriendlyId(): string {
    const adjectives = ['swift', 'bright', 'calm', 'bold', 'wise', 'keen'];
    const nouns = ['fox', 'hawk', 'wolf', 'bear', 'lion', 'eagle'];

    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 100);

    return `${adj}-${noun}-${num}`;
  }
}
