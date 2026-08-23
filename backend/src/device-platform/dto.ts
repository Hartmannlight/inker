import { IsString, MaxLength, MinLength } from 'class-validator';

export class PairWebDisplayDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  externalId: string;

  @IsString()
  @MinLength(32)
  @MaxLength(256)
  pairingToken: string;
}
