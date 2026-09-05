import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsObject,
  IsArray,
  ValidateIf,
  MaxLength,
} from 'class-validator';

export interface FirmwareLogEntry {
  level?: unknown;
  message?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

/**
 * Create log DTO - supports both single and batch formats
 *
 * Single format: { level: "info", message: "..." }
 * Batch format: { logs: [{ level: "info", message: "..." }, ...] }
 *
 * TRMNL firmware sends extra fields in batch log entries (created_at, id,
 * source_line, battery_voltage, etc.) and numeric log levels.
 * Unknown firmware fields remain accepted, while the service projects only
 * bounded primitive values into persistence.
 * The service extracts only the fields it needs (level, message, metadata).
 */
export class CreateLogDto {
  // Single log format (used when logs array is not present)
  @ApiProperty({ example: 'info', description: 'Log level', required: false })
  @ValidateIf((o) => !o.logs)
  @IsString()
  @MaxLength(20)
  level?: string;

  @ApiProperty({
    example: 'Device started successfully',
    description: 'Log message',
    required: false,
  })
  @ValidateIf((o) => !o.logs)
  @IsString()
  @MaxLength(5000)
  message?: string;

  @ApiProperty({
    example: { battery: 85.5, wifi: 75 },
    required: false,
    description: 'Additional metadata',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  // Batch format from TRMNL firmware
  @ApiProperty({
    required: false,
    description: 'Array of log entries (batch format)',
  })
  @IsOptional()
  @IsArray()
  logs?: FirmwareLogEntry[];
}
