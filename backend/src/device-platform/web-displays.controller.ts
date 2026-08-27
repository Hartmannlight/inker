import { Body, Controller, Get, Headers, Param, Post, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { matchesIfNoneMatch } from './pull-content.controller';
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
  @Get(':externalId/artifacts/:sha256')
  async artifact(@Param('externalId') externalId: string, @Param('sha256') hash: string,
    @Headers('authorization') authorization: string | undefined, @Headers('if-none-match') validator: string | undefined,
    @Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Device credential required');
    const device = await this.auth.authenticate(externalId, token);
    const artifact = await this.presentations.artifact(device.id, hash);
    const etag = `"${artifact.sha256}"`;
    response.set({ ETag: etag, 'Cache-Control': 'private, no-cache' });
    response.vary('Authorization');
    if (matchesIfNoneMatch(validator, etag)) { response.status(304).end(); return; }
    response.type(artifact.mimeType).status(200).send(artifact.bytes);
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
