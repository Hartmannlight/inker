import { Controller, Get, Headers, NotFoundException, Param, Res } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PullDeviceAuthService } from './pull-device-auth.service';
import { PullContentService } from './pull-content.service';

/** RFC 9110 sections 5.6.1.2 / 13.1.2: weak comparison and recipient list grammar. */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const tagPattern = /(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/y;
  let offset = 0;
  let matched = false;
  const skipWhitespace = () => { while (header[offset] === ' ' || header[offset] === '\t') offset++; };
  while (offset < header.length) {
    skipWhitespace();
    if (offset === header.length) break;
    if (header[offset] === ',') { offset++; continue; }
    tagPattern.lastIndex = offset;
    const tag = tagPattern.exec(header);
    if (!tag) return false;
    matched ||= tag[0].replace(/^W\//, '') === etag.replace(/^W\//, '');
    offset = tagPattern.lastIndex;
    skipWhitespace();
    if (offset < header.length && header[offset] !== ',') return false;
    if (header[offset] === ',') offset++;
  }
  return matched;
}

@Controller('v1/device-content')
@Public() // Only bypasses the ADMIN guard; every handler authenticates the device first.
export class PullContentController {
  constructor(private readonly auth: PullDeviceAuthService, private readonly content: PullContentService) {}

  @Get()
  async manifest(@Headers() headers: IncomingHttpHeaders, @Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const device = await this.auth.authenticate(headers);
    const result = await this.content.read(device);
    this.setDeliveryHeaders(response, result, result.etag);
    if (matchesIfNoneMatch(headers['if-none-match'], result.etag)) {
      response.status(304).end();
      return;
    }
    response.status(200).json(result.manifest);
  }

  @Get('artifacts/:sha256')
  async artifact(@Headers() headers: IncomingHttpHeaders, @Param('sha256') sha256: string, @Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const device = await this.auth.authenticate(headers);
    const result = await this.content.read(device);
    // Authorization is to the current desired variant, not to an unrestricted hash store.
    if (!/^[a-f0-9]{64}$/.test(sha256) || result.artifact.sha256 !== sha256) {
      throw new NotFoundException('Published artifact not found');
    }
    this.setDeliveryHeaders(response, result, result.artifactEtag);
    if (matchesIfNoneMatch(headers['if-none-match'], result.artifactEtag)) {
      response.status(304).end();
      return;
    }
    response.type(result.artifact.mimeType).status(200).send(result.artifact.bytes);
  }

  private setDeliveryHeaders(response: Response, result: Awaited<ReturnType<PullContentService['read']>>, etag: string) {
    response.set({ ETag: etag, 'Cache-Control': 'private, no-cache',
      'X-Refresh-After-Seconds': String(result.hints.refreshAfterSeconds), 'X-Delivery-Mode': result.deliveryMode });
    response.vary('Authorization, HTTP_ID, Access-Token');
  }
}
