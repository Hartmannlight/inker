import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class PlaylistScreenDto {
  @IsString()
  screenId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  duration?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}
