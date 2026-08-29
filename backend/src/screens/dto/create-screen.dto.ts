import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsString, IsOptional, IsInt, IsBoolean, IsUrl, MaxLength } from 'class-validator';

export class CreateScreenDto {
  /** Multer may retain the multipart field on the validated body; it is never persisted. */
  @Allow()
  file?: unknown;

  @ApiProperty({
    example: 'Weather Dashboard',
    description: 'Screen name',
  })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    example: 'Displays current weather and forecast',
    description: 'Screen description',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    example: 'https://example.com/screens/weather.png',
    description: 'Full-size image URL',
  })
  @IsOptional()
  @IsString()
  @IsUrl()
  @MaxLength(2048)
  imageUrl?: string;

  @ApiPropertyOptional({
    example: 'https://example.com/screens/weather-thumb.png',
    description: 'Thumbnail image URL',
  })
  @IsOptional()
  @IsString()
  @IsUrl()
  @MaxLength(2048)
  thumbnailUrl?: string;

  @ApiPropertyOptional({ example: 800, description: 'Known raster width in pixels' })
  @IsOptional()
  @IsInt()
  width?: number;

  @ApiPropertyOptional({ example: 480, description: 'Known raster height in pixels' })
  @IsOptional()
  @IsInt()
  height?: number;

  @ApiPropertyOptional({
    example: false,
    description: 'Whether screen is publicly accessible',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
