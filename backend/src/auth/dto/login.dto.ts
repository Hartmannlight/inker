import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'Admin password', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password?: string;

  @ApiProperty({ description: 'Legacy request field; use password', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  pin?: string;
}
