import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class DisplayControlDto {
  @ApiProperty({ example: 100, minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  brightness!: number;

  @ApiProperty({ example: true })
  @IsBoolean()
  scheduleEnabled!: boolean;

  @ApiPropertyOptional({ example: '22:00', default: '22:00' })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  dimStartAt?: string;

  @ApiPropertyOptional({ example: '07:00', default: '07:00' })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  dimStopAt?: string;

  @ApiProperty({ example: 20, minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  dimBrightness!: number;

  @ApiProperty({ example: 'Europe/Berlin' })
  @IsString()
  @MaxLength(128)
  timezone!: string;

  @ApiPropertyOptional({ example: '#ffffff', default: '#000000' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  foregroundColor?: string;

  @ApiPropertyOptional({ example: '#000000', default: '#ffffff' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  backgroundColor?: string;
}
