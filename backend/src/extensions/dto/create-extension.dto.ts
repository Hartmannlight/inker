import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { IsString, IsOptional, IsBoolean, IsIn, IsObject } from 'class-validator';

export class CreateExtensionDto {
  @ApiProperty({
    example: 'Weather Plugin',
    description: 'Extension name',
  })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    example: 'Displays weather information',
    description: 'Extension description',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: 'webhook',
    description: 'Extension type',
    enum: ['webhook', 'polling', 'custom'],
  })
  @IsString()
  @IsIn(['webhook', 'polling', 'custom'])
  type: string;

  @ApiPropertyOptional({
    example: { apiKey: 'xxx', endpoint: 'https://api.example.com' },
    description: 'Extension configuration (JSON)',
  })
  @IsOptional()
  @IsObject()
  config?: Prisma.InputJsonObject;

  @ApiPropertyOptional({
    example: true,
    description: 'Extension active status',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
