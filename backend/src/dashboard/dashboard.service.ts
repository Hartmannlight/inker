import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardStatsDto } from './dto/dashboard-stats.dto';
import * as https from 'https';
import packageMetadata from '../../package.json';
import { isNewerVersion } from '../common/utils/version.util';

const CURRENT_VERSION = packageMetadata.version;

export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
}

/**
 * Dashboard service
 * Provides aggregated statistics for the dashboard view
 *
 * Per Node.js best practices, this service:
 * - Uses async/await for database operations
 * - Implements proper error handling
 * - Uses structured logging for observability
 * - Optimizes database queries with Prisma
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  private versionCache: { data: VersionCheckResult; timestamp: number } | null = null;
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get dashboard statistics including counts and recent items
   *
   * This method performs multiple database queries in parallel using Promise.all
   * for optimal performance. Device online status is determined by checking
   * if lastSeenAt is within the last 5 minutes.
   *
   * @returns DashboardStatsDto containing all dashboard statistics
   */
  async getStats(): Promise<DashboardStatsDto> {
    this.logger.log('Fetching dashboard statistics');

    try {
      // Calculate the timestamp for "online" devices (last 5 minutes)
      const onlineThreshold = new Date(Date.now() - 5 * 60 * 1000);

      // Execute all queries in parallel for optimal performance
      const [
        totalDevices,
        onlineDevices,
        totalScreens,
        totalPlaylists,
        recentDevices,
        recentScreens,
      ] = await Promise.all([
        // Count total devices
        this.prisma.device.count(),

        // Count online devices (seen within last 5 minutes)
        this.prisma.device.count({
          where: {
            lastSeenAt: {
              gte: onlineThreshold,
            },
          },
        }),

        // Count total screen designs
        this.prisma.screenDesign.count(),

        // Count total playlists
        this.prisma.playlist.count(),

        // Get 5 most recent devices with relevant fields
        this.prisma.device.findMany({
          take: 5,
          orderBy: {
            createdAt: 'desc',
          },
          select: {
            id: true,
            name: true,
            macAddress: true,
            lastSeenAt: true,
            createdAt: true,
            battery: true,
            wifi: true,
          },
        }),

        // Get 4 most recent screen designs with relevant fields
        this.prisma.screenDesign.findMany({
          take: 4,
          orderBy: {
            createdAt: 'desc',
          },
          select: {
            id: true,
            name: true,
            description: true,
            createdAt: true,
          },
        }),
      ]);

      // Map devices to include computed status field
      const mappedDevices = recentDevices.map(device => ({
        ...device,
        status: this.getDeviceStatus(device.lastSeenAt, onlineThreshold),
      }));

      const stats: DashboardStatsDto = {
        totalDevices,
        onlineDevices,
        totalScreens,
        totalPlaylists,
        recentDevices: mappedDevices,
        recentScreens,
      };

      this.logger.log(
        `Dashboard stats retrieved: ${totalDevices} devices (${onlineDevices} online), ` +
        `${totalScreens} screens, ${totalPlaylists} playlists`
      );

      return stats;
    } catch (error) {
      this.logger.error('Failed to fetch dashboard statistics', error);
      throw error;
    }
  }

  /**
   * Determine device status based on lastSeenAt timestamp
   *
   * @param lastSeenAt - Last time device was seen
   * @param onlineThreshold - Threshold date for considering device online
   * @returns 'online' or 'offline'
   */
  private getDeviceStatus(
    lastSeenAt: Date | null,
    onlineThreshold: Date
  ): 'online' | 'offline' {
    if (!lastSeenAt) {
      return 'offline';
    }
    return lastSeenAt >= onlineThreshold ? 'online' : 'offline';
  }

  async checkForUpdate(): Promise<VersionCheckResult> {
    if (this.versionCache && Date.now() - this.versionCache.timestamp < this.CACHE_TTL) {
      return this.versionCache.data;
    }

    try {
      const release = await this.fetchLatestRelease();
      const latestVersion = (release.tag_name || '').replace(/^v/, '');
      const updateAvailable = isNewerVersion(latestVersion, CURRENT_VERSION);
      const data = {
        currentVersion: CURRENT_VERSION,
        latestVersion: latestVersion || CURRENT_VERSION,
        updateAvailable,
        releaseUrl: release.html_url || 'https://github.com/usetrmnl/inker/releases',
      };
      this.versionCache = { data, timestamp: Date.now() };
      return data;
    } catch (error) {
      this.logger.warn('Failed to check for updates', error);
      return {
        currentVersion: CURRENT_VERSION,
        latestVersion: CURRENT_VERSION,
        updateAvailable: false,
        releaseUrl: 'https://github.com/usetrmnl/inker/releases',
      };
    }
  }

  private fetchLatestRelease(): Promise<GitHubRelease> {
    return new Promise((resolve, reject) => {
      const req = https.get(
        'https://api.github.com/repos/usetrmnl/inker/releases/latest',
        { headers: { 'User-Agent': 'Inker', Accept: 'application/vnd.github.v3+json' } },
        (res) => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            reject(new Error(`GitHub release request failed with HTTP ${res.statusCode ?? 'unknown'}`));
            return;
          }
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const parsed: unknown = JSON.parse(data);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                reject(new Error('Invalid JSON from GitHub'));
                return;
              }
              resolve(parsed as GitHubRelease);
            } catch {
              reject(new Error('Invalid JSON from GitHub'));
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

}
