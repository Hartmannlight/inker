import { Injectable } from '@nestjs/common';
import type { Device } from '@prisma/client';
import type { IncomingHttpHeaders } from 'node:http';
import { PrismaService } from '../prisma/prisma.service';

const finiteHeader = (value: string | string[] | undefined, minimum: number, maximum: number): number | undefined => {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
};

/** Small, bounded telemetry carried by authenticated HTTP-pull clients. */
@Injectable()
export class PullTelemetryService {
  constructor(private readonly prisma: PrismaService) {}

  async observe(device: Pick<Device, 'id' | 'battery' | 'wifi' | 'firmwareVersion'>, headers: IncomingHttpHeaders) {
    const wifi = finiteHeader(headers['x-inker-wifi-rssi'], -127, 0);
    const battery = finiteHeader(headers['x-inker-battery-percent'], 0, 100);
    const firmware = headers['x-inker-firmware-version'];
    const firmwareVersion = typeof firmware === 'string' && /^[A-Za-z0-9._+-]{1,32}$/.test(firmware) ? firmware : undefined;
    const data = {
      ...(wifi !== undefined && wifi !== device.wifi ? { wifi } : {}),
      ...(battery !== undefined && battery !== device.battery ? { battery } : {}),
      ...(firmwareVersion !== undefined && firmwareVersion !== device.firmwareVersion ? { firmwareVersion } : {}),
    };
    if (Object.keys(data).length) await this.prisma.device.update({ where: { id: device.id }, data });
  }
}
