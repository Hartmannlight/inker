import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, Min, Matches, MaxLength, MinLength, IsIn, ValidateIf, IsObject } from 'class-validator';

export class CreateDeviceDto {
  @ApiProperty({
    example: 'Living Room Display',
    description: 'Device name',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    example: 'AA:BB:CC:DD:EE:FF',
    description: 'Device MAC address (required for TRMNL, unused by web displays)',
  })
  @ValidateIf((dto) => (dto.deviceType ?? 'trmnl') === 'trmnl')
  @IsString()
  @Matches(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/, {
    message: 'Invalid MAC address format',
  })
  macAddress?: string;

  @ApiPropertyOptional({
    example: 'trmnl',
    enum: ['trmnl', 'web-display'],
    default: 'trmnl',
  })
  @IsOptional()
  @IsString()
  @IsIn(['trmnl', 'web-display'])
  deviceType?: 'trmnl' | 'web-display';

  @ApiPropertyOptional({
    example: 'trmnl-byod-7.5-mono',
    description: 'Versioned device profile ID. Defaults from the legacy deviceType when omitted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  profileId?: string;

  @ApiPropertyOptional({
    example: 'reference-sleepy',
    description: 'Versioned delivery policy ID. Defaults from the selected profile/device type when omitted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deliveryPolicyId?: string;

  @ApiPropertyOptional({
    example: { display: { width: 1280, height: 720 } },
    description: 'Partial capability override. Identity and protocol version cannot be overridden.',
  })
  @IsOptional()
  @IsObject()
  capabilitiesOverride?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 1,
    description: 'Playlist ID to assign',
  })
  @IsOptional()
  @IsInt()
  playlistId?: number;

  @ApiPropertyOptional({
    example: 800,
    description: 'Deprecated compatibility input; stored as a display capability override.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @ApiPropertyOptional({
    example: 480,
    description: 'Deprecated compatibility input; stored as a display capability override.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;
}
