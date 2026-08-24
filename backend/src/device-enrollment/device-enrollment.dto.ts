import { IsString, MaxLength } from 'class-validator';

export class ExchangeDeviceEnrollmentDto {
  @IsString()
  @MaxLength(32)
  code: string;
}
