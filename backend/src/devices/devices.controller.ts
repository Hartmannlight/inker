import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Patch,
  Param,
  Delete,
  Headers,
  Query,
  Res,
  ParseIntPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiHeader,
} from '@nestjs/swagger';
import { DevicesService } from './devices.service';
import { ContentAssignmentService } from './content-assignment.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { DisplayControlDto } from './dto/display-control.dto';
import { DisplayTechnologyDto } from './dto/display-technology.dto';
import { Public } from '../common/decorators/public.decorator';
import { PresentationService } from '../device-platform/presentation.service';
import { matchesIfNoneMatch } from '../common/utils/http-cache.util';

@ApiTags('devices')
@Controller('devices')
export class DevicesController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly presentations: PresentationService,
    private readonly assignments: ContentAssignmentService,
  ) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Create a new device' })
  @ApiResponse({ status: 201, description: 'Device successfully created' })
  @ApiResponse({ status: 400, description: 'Device with MAC address already exists' })
  create(@Body() createDeviceDto: CreateDeviceDto) {
    return this.devicesService.create(createDeviceDto);
  }

  @Get()
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get all devices with pagination' })
  @ApiResponse({ status: 200, description: 'List of devices' })
  findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = Math.max(parseInt(page || '1', 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit || '20', 10) || 20, 1), 100);
    return this.devicesService.findAll(pageNum, limitNum);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get device by ID' })
  @ApiResponse({ status: 200, description: 'Device details' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.devicesService.findOne(id);
  }

  @Get(':id/display-control')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Read LCD brightness and dimming settings' })
  getDisplayControl(@Param('id', ParseIntPipe) id: number) {
    return this.devicesService.getDisplayControl(id);
  }

  @Put(':id/display-control')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Set LCD brightness and its time-based dimming schedule' })
  updateDisplayControl(@Param('id', ParseIntPipe) id: number, @Body() body: DisplayControlDto) {
    return this.devicesService.updateDisplayControl(id, body);
  }

  @Put(':id/display-technology')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Choose LCD/color or E-ink/dithered rendering for a web-connected device' })
  updateDisplayTechnology(@Param('id', ParseIntPipe) id: number, @Body() body: DisplayTechnologyDto) {
    return this.devicesService.updateDisplayTechnology(id, body.technology);
  }

  @Get(':id/preview')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get the currently assigned immutable device artifact for an admin preview' })
  @ApiResponse({ status: 200, description: 'Current published device artifact' })
  @ApiResponse({ status: 304, description: 'Artifact has not changed' })
  @ApiResponse({ status: 404, description: 'Device or published device content not found' })
  async preview(
    @Param('id', ParseIntPipe) id: number,
    @Headers('if-none-match') validator: string | undefined,
    @Res() response: Response,
  ) {
    const artifact = await this.presentations.preview(id);
    const etag = `"${artifact.sha256}"`;
    response.set({ ETag: etag, 'Cache-Control': 'private, no-cache' });
    response.vary('Cookie');
    if (matchesIfNoneMatch(validator, etag)) {
      response.status(304).end();
      return;
    }
    response.type(artifact.mimeType).status(200).send(artifact.bytes);
  }

  @Patch(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Update device (PATCH)' })
  @ApiResponse({ status: 200, description: 'Device successfully updated' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDeviceDto: UpdateDeviceDto,
  ) {
    return this.devicesService.update(id, updateDeviceDto);
  }

  @Put(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Update device (PUT)' })
  @ApiResponse({ status: 200, description: 'Device successfully updated' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  updatePut(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDeviceDto: UpdateDeviceDto,
  ) {
    return this.devicesService.update(id, updateDeviceDto);
  }

  @Delete(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Delete device' })
  @ApiResponse({ status: 200, description: 'Device successfully deleted' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.devicesService.remove(id);
  }

  @Post(':id/regenerate-key')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Regenerate device API key' })
  @ApiResponse({ status: 200, description: 'API key regenerated' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  regenerateKey(@Param('id', ParseIntPipe) id: number) {
    return this.devicesService.regenerateApiKey(id);
  }

  @Put(':id/content-assignment')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Atomically assign no content, one publication revision, or one published playlist revision' })
  contentAssignment(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    return this.assignments.assign(id, body);
  }

  @Get(':id/content-assignment')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Read the current content assignment and eligible single/rotating content choices' })
  contentAssignmentChoices(@Param('id', ParseIntPipe) id: number) {
    return this.assignments.read(id);
  }

  @Get(':id/logs')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get device logs' })
  @ApiResponse({ status: 200, description: 'Device logs' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  getLogs(@Param('id', ParseIntPipe) id: number) {
    return this.devicesService.getDeviceLogs(id);
  }

  @Post(':id/refresh')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Trigger device refresh' })
  @ApiResponse({ status: 200, description: 'Device refresh triggered' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  triggerRefresh(@Param('id', ParseIntPipe) id: number) {
    return this.devicesService.triggerRefresh(id);
  }

  @Delete(':id/playlist')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Unassign playlist from device',
    description:
      'Removes the playlist assignment from a device. The device will display ' +
      'the default "Hello World" screen until a new playlist is assigned.',
  })
  @ApiResponse({
    status: 200,
    description: 'Playlist unassigned successfully. Device will show default screen.',
  })
  @ApiResponse({ status: 404, description: 'Device not found' })
  @ApiResponse({ status: 400, description: 'Device has no playlist assigned' })
  unassignPlaylist(@Param('id', ParseIntPipe) id: number) {
    return this.devicesService.unassignPlaylist(id);
  }

  /**
   * PUBLIC ENDPOINTS FOR DEVICE COMMUNICATION
   */

  @Public()
  @Get('display/content')
  @ApiHeader({
    name: 'X-Device-Key',
    description: 'Device API Key',
    required: true,
  })
  @ApiOperation({
    summary: 'Get display content for device (device polling endpoint)',
  })
  @ApiResponse({ status: 200, description: 'Current screen to display' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  @ApiResponse({ status: 403, description: 'Device is inactive' })
  getDisplayContent(@Headers('x-device-key') apiKey: string) {
    return this.devicesService.getDisplayContent(apiKey);
  }

}
