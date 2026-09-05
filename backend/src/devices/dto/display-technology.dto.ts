import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class DisplayTechnologyDto {
  @ApiProperty({ enum: ['lcd', 'eink'], example: 'lcd' })
  @IsIn(['lcd', 'eink'])
  technology!: 'lcd' | 'eink';
}
