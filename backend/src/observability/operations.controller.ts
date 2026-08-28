import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { OperationsService } from './operations.service';

/** Normal admin guard applies; no public decorator and no mutating operations. */
@Controller('operations')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  status() { return this.operations.status(); }
  @Get('metrics')
  async metrics(@Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    response.type('text/plain; version=0.0.4; charset=utf-8').send(await this.operations.metrics());
  }
}
