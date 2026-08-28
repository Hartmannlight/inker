import { Body, Controller, Get, Header, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { RemoteSubscriptionsService } from './remote-subscriptions.service';

// Existing global admin-session and CSRF guards apply. No public/device routes.
@Controller('remote-subscriptions')
export class RemoteSubscriptionsController {
  constructor(private readonly subscriptions: RemoteSubscriptionsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list() { return this.subscriptions.list(); }
  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Body() body: unknown) { return this.subscriptions.create(body); }
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id') id: string, @Body() body: unknown) { return this.subscriptions.update(id, body); }
  @Post(':id/sync')
  @Header('Cache-Control', 'no-store')
  sync(@Param('id') id: string, @Body() body: unknown) { return this.subscriptions.sync(id, body); }
  @Put(':id/devices/:deviceId')
  @Header('Cache-Control', 'no-store')
  assign(@Param('id') id: string, @Param('deviceId', ParseIntPipe) deviceId: number, @Body() body: unknown) {
    return this.subscriptions.assign(id, deviceId, body);
  }
}
