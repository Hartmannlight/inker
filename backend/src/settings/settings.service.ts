import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Known setting keys
export const SETTING_KEYS = {
  ALLOW_LOCAL_NETWORK: 'allow_local_network',
  WELCOME_SCREEN: 'welcome_screen',
} as const;

export interface WelcomeScreenConfig {
  enabled: boolean;
  title: string;
  subtitle: string;
  autoAssignPlaylist: boolean;
}

const DEFAULT_WELCOME_SCREEN_CONFIG: WelcomeScreenConfig = {
  enabled: true,
  title: 'Hello World',
  subtitle: 'This is inker!',
  autoAssignPlaylist: true,
};

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get a setting value by key
   */
  async get(key: string): Promise<string | null> {
    const setting = await this.prisma.setting.findUnique({
      where: { key },
    });
    return setting?.value ?? null;
  }

  /**
   * Set a setting value (create or update)
   */
  async set(key: string, value: string): Promise<void> {
    this.logger.log(`Setting ${key}`);
    await this.prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  /**
   * Delete a setting
   */
  async delete(key: string): Promise<void> {
    this.logger.log(`Deleting setting ${key}`);
    await this.prisma.setting.deleteMany({
      where: { key },
    });
  }

  /**
   * Get all settings (with masked sensitive values)
   */
  async getAll(): Promise<Record<string, string | null>> {
    const settings = await this.prisma.setting.findMany();
    const result: Record<string, string | null> = {};

    // Initialize all known keys with null
    for (const key of Object.values(SETTING_KEYS)) {
      result[key] = null;
    }

    // Fill in actual values (masked for sensitive ones)
    for (const setting of settings) {
      if (this.isSensitive(setting.key)) {
        // Return masked value to indicate it's set
        result[setting.key] = setting.value ? '••••••••' : null;
      } else {
        result[setting.key] = setting.value;
      }
    }

    return result;
  }

  /**
   * Check if a setting key contains sensitive data
   */
  private isSensitive(key: string): boolean {
    const sensitiveKeys = ['token', 'key', 'secret', 'password'];
    return sensitiveKeys.some((s) => key.toLowerCase().includes(s));
  }

  /**
   * Get welcome screen configuration
   */
  async getWelcomeScreenConfig(): Promise<WelcomeScreenConfig> {
    const value = await this.get(SETTING_KEYS.WELCOME_SCREEN);
    if (!value) {
      return { ...DEFAULT_WELCOME_SCREEN_CONFIG };
    }
    try {
      return { ...DEFAULT_WELCOME_SCREEN_CONFIG, ...JSON.parse(value) };
    } catch {
      return { ...DEFAULT_WELCOME_SCREEN_CONFIG };
    }
  }

  /**
   * Save welcome screen configuration and invalidate cached default screen
   */
  async setWelcomeScreenConfig(config: WelcomeScreenConfig): Promise<WelcomeScreenConfig> {
    await this.set(SETTING_KEYS.WELCOME_SCREEN, JSON.stringify(config));
    // Delete cached default screen so it regenerates with new title/subtitle
    await this.invalidateDefaultScreen();
    return config;
  }

  /**
   * Delete cached default screen PNG so it regenerates from config on next access
   */
  async invalidateDefaultScreen(): Promise<void> {
    const path = await import('path');
    const fs = await import('fs/promises');
    const defaultScreenPath = path.join(process.cwd(), 'assets', 'default-screen.png');
    try {
      await fs.unlink(defaultScreenPath);
      this.logger.log('Default screen cache invalidated');
    } catch {
      // File doesn't exist, nothing to invalidate
    }
  }

}
