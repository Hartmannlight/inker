import { Body, Controller, Get, Header, Headers, HttpCode, Post, Res } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { InteractionService } from './interaction.service';

@Public() // This endpoint requires its own device credential, never an admin session.
@Controller('interactions')
export class InteractionsController {
  constructor(private readonly interactions: InteractionService) {}
  @Get('context')
  @Header('Cache-Control', 'no-store')
  context(@Headers() headers: IncomingHttpHeaders) { return this.interactions.context(headers); }
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async execute(@Headers() headers: IncomingHttpHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const result = await this.interactions.execute(headers, body);
    response.setHeader('X-Correlation-ID', result.commandId);
    return result;
  }
}
