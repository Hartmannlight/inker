import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateLogDto } from './dto/create-log.dto';
import { Prisma } from '@prisma/client';
import { isJsonValue } from '@inker/contracts';
import { mergeLegacyPullTelemetry } from '../../device-platform/legacy-pull-telemetry';

function logMetadata(value: unknown): Prisma.InputJsonValue {
  return value !== null && isJsonValue(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Prisma.InputJsonObject
    : {};
}

@Injectable()
export class LogService {
  private readonly logger = new Logger(LogService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Create device log entry
   * Called by device to send log data
   * Supports both single log format and batch format
   */
  async createLog(identifier: string, createLogDto: CreateLogDto) {
    // Find device by MAC address or API key (firmware sends MAC via ID header)
    const device = await this.prisma.device.findFirst({
      where: {
        OR: [
          { macAddress: identifier },
          { apiKey: identifier },
        ],
      },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    // Handle batch format from TRMNL firmware
    if (createLogDto.logs && Array.isArray(createLogDto.logs)) {
      const entries = createLogDto.logs.slice(0, 100); // Cap at 100 entries to prevent DoS
      const createdLogs = await Promise.all(
        entries.map((logEntry) =>
          this.prisma.deviceLog.create({
            data: {
              deviceId: device.id,
              level: (typeof logEntry.level === 'string' || typeof logEntry.level === 'number')
                ? String(logEntry.level).slice(0, 20) : 'info',
              message: typeof logEntry.message === 'string' ? logEntry.message.slice(0, 5000) : '',
              metadata: logMetadata(logEntry.metadata),
            },
          }),
        ),
      );

      this.logger.debug(
        `Created ${createdLogs.length} batch logs for device ${device.name}`,
      );

      return {
        status: 'ok',
        message: `${createdLogs.length} logs created successfully`,
        count: createdLogs.length,
      };
    }

    // Handle single log format
    const log = await this.prisma.deviceLog.create({
      data: {
        deviceId: device.id,
        level: createLogDto.level || 'info',
        message: createLogDto.message || '',
        metadata: logMetadata(createLogDto.metadata),
      },
    });

    this.logger.debug(
      `Log created for device ${device.name}: [${log.level}] ${log.message}`,
    );

    // Update device metadata if provided
    if (createLogDto.metadata) {
      const updates: Prisma.DeviceUpdateInput = {};

      const battery = typeof createLogDto.metadata.battery === 'number' &&
        Number.isFinite(createLogDto.metadata.battery) ? createLogDto.metadata.battery : undefined;
      const wifi = typeof createLogDto.metadata.wifi === 'number' &&
        Number.isFinite(createLogDto.metadata.wifi) ? createLogDto.metadata.wifi : undefined;

      if (battery !== undefined) {
        updates.battery = battery;
      }

      if (wifi !== undefined) {
        updates.wifi = wifi;
      }

      if (battery !== undefined || wifi !== undefined) {
        updates.telemetry = mergeLegacyPullTelemetry(device.telemetry, { battery, wifi });
      }

      if (Object.keys(updates).length > 0) {
        await this.prisma.device.update({
          where: { id: device.id },
          data: {
            ...updates,
            lastSeenAt: new Date(),
          },
        });
      }
    }

    return {
      status: 'ok',
      message: 'Log created successfully',
    };
  }
}
