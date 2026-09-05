import { Controller, Get, Headers, Res } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { TimerService } from '../timers/timer.service';
import { timerFeedResult } from '../timers/timer-feed';
import { PullDeviceAuthService } from './pull-device-auth.service';
import { matchesIfNoneMatch } from '../common/utils/http-cache.util';

@Public()
@Controller('timers')
export class TimersController {
  constructor(private readonly auth: PullDeviceAuthService, private readonly timers: TimerService) {}

  @Get()
  async list(@Headers() headers: IncomingHttpHeaders, @Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const device = await this.auth.authenticate(headers);
    const result = timerFeedResult(await this.timers.listForAuthenticatedDevice(device.id));
    // Revalidate revocation/expiry after reading private state, including 304.
    await this.auth.authenticate(headers);
    response.set({ ETag: result.etag, 'Cache-Control': 'private, no-cache', 'X-Server-Time': result.feed.serverTime });
    response.vary('Authorization, HTTP_ID, Access-Token');
    if (matchesIfNoneMatch(headers['if-none-match'], result.etag)) { response.status(304).end(); return; }
    response.status(200).json(result.feed);
  }
}
