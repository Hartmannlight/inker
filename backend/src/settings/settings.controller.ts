import { Controller, Get, Put, Post, Delete, Param, Body, BadRequestException } from '@nestjs/common';
import { SettingsService, SETTING_KEYS } from './settings.service';
import { UpdateSettingDto } from './dto/update-setting.dto';
import { WelcomeScreenConfigDto } from './dto/welcome-screen-config.dto';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  /**
   * Get welcome screen configuration
   */
  @Get('welcome-screen')
  async getWelcomeScreenConfig() {
    return this.settingsService.getWelcomeScreenConfig();
  }

  /**
   * Save welcome screen configuration
   * Invalidates cached default screen so it regenerates with new title/subtitle
   */
  @Put('welcome-screen')
  async saveWelcomeScreenConfig(@Body() body: WelcomeScreenConfigDto) {
    return this.settingsService.setWelcomeScreenConfig(body);
  }

  /**
   * Regenerate default screen by invalidating cache
   */
  @Post('welcome-screen/regenerate')
  async regenerateWelcomeScreens() {
    await this.settingsService.invalidateDefaultScreen();
    return { success: true };
  }

  /**
   * Get welcome screen preview URL
   */
  @Get('welcome-screen/preview')
  async getWelcomeScreenPreview() {
    return { url: '/assets/default-screen.png' };
  }

  /**
   * Get all settings (with sensitive values masked)
   */
  @Get()
  async getAll() {
    return this.settingsService.getAll();
  }

  /**
   * Get known setting keys
   */
  @Get('keys')
  getKeys() {
    return SETTING_KEYS;
  }

  /**
   * Update a setting
   */
  @Put(':key')
  async update(@Param('key') key: string, @Body() body: UpdateSettingDto) {
    const allowedKeys = Object.values(SETTING_KEYS);
    if (!allowedKeys.includes(key as any)) {
      throw new BadRequestException(`Invalid setting key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
    }
    await this.settingsService.set(key, body.value);
    return { success: true };
  }

  /**
   * Delete a setting
   */
  @Delete(':key')
  async delete(@Param('key') key: string) {
    const allowedKeys = Object.values(SETTING_KEYS);
    if (!allowedKeys.includes(key as any)) {
      throw new BadRequestException(`Invalid setting key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
    }
    await this.settingsService.delete(key);
    return { success: true };
  }
}
