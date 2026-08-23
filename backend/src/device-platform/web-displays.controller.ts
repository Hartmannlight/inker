import { Body, Controller, Get, Headers, Param, Post, UnauthorizedException } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PairWebDisplayDto } from './dto';
import { PresentationService } from './presentation.service';
import { WebDisplayAuthService } from './web-display-auth.service';

@Controller('web-displays')
export class WebDisplaysController {
  constructor(
    private readonly auth: WebDisplayAuthService,
    private readonly presentations: PresentationService,
  ) {}

  @Public()
  @Post('pair')
  pair(@Body() dto: PairWebDisplayDto) {
    return this.auth.pair(dto.externalId, dto.pairingToken);
  }

  @Public()
  @Get(':externalId/presentation')
  async presentation(
    @Param('externalId') externalId: string,
    @Headers('authorization') authorization?: string,
  ) {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Device credential required');
    const device = await this.auth.authenticate(externalId, token);
    return this.presentations.getForDevice(device.id);
  }
}
