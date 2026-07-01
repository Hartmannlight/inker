import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, IsBoolean, Min, Matches, ValidateIf, MaxLength } from 'class-validator';

export class UpdateDeviceDto {
  @ApiPropertyOptional({
    example: 'Living Room Display',
    description: 'Device name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    example: 'AA:BB:CC:DD:EE:FF',
    description: 'Device MAC address',
  })
  @IsOptional()
  @IsString()
  @Matches(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/, {
    message: 'Invalid MAC address format',
  })
  macAddress?: string;

  @ApiPropertyOptional({
    example: '1.0.5',
    description: 'Firmware version',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  firmwareVersion?: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Playlist ID (set to null to unassign)',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((object, value) => value !== null)
  @IsInt()
  playlistId?: number | null;

  @ApiPropertyOptional({
    example: true,
    description: 'Device active status',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    example: 800,
    description: 'Custom screen width in pixels (used instead of model dimensions)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @ApiPropertyOptional({
    example: 480,
    description: 'Custom screen height in pixels (used instead of model dimensions)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;

  @ApiPropertyOptional({
    example: '22:00',
    description: 'Quiet hours start time (HH:MM, evaluated in DEFAULT_TIMEZONE). Set to null to disable night sleep.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((object, value) => value !== null)
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'sleepStartAt must be in HH:MM format' })
  sleepStartAt?: string | null;

  @ApiPropertyOptional({
    example: '07:00',
    description: 'Quiet hours end / wake time (HH:MM, evaluated in DEFAULT_TIMEZONE). Set to null to disable night sleep.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((object, value) => value !== null)
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'sleepStopAt must be in HH:MM format' })
  sleepStopAt?: string | null;

  @ApiPropertyOptional({
    example: false,
    description: 'During quiet hours, show a dedicated sleep screen (true) or keep the current screen frozen (false)',
  })
  @IsOptional()
  @IsBoolean()
  showSleepScreen?: boolean;
}
