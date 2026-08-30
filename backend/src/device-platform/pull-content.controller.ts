import { Controller, Get, Headers, NotFoundException, Param, Res } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PullDeviceAuthService } from './pull-device-auth.service';
import { PullContentService } from './pull-content.service';
import { PullTelemetryService } from './pull-telemetry.service';
import { PullArtifactLeaseService } from './pull-artifact-lease.service';

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
  constructor(
    private readonly auth: PullDeviceAuthService,
    private readonly content: PullContentService,
    private readonly telemetry: PullTelemetryService,
    private readonly leases: PullArtifactLeaseService,
  ) {}

  @Get()
  async manifest(@Headers() headers: IncomingHttpHeaders, @Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const device = await this.auth.authenticate(headers);
    await this.telemetry.observe(device, headers);
    const result = await this.content.read(device);
    this.leases.issue(device.id, result.artifact);
    await this.auth.authenticate(headers);
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
    const current = await this.content.read(device, false);
    const artifact = current.artifact.sha256 === sha256 ? current.artifact : this.leases.read(device.id, sha256);
    // Authorization is limited to the current variant or the artifact announced
    // to this same device moments earlier; this closes the manifest/artifact race.
    if (!/^[a-f0-9]{64}$/.test(sha256) || !artifact) {
      throw new NotFoundException('Published artifact not found');
    }
    const result = { ...current, artifact, artifactEtag: `"${artifact.sha256}"` };
    this.setDeliveryHeaders(response, result, result.artifactEtag);
    if (matchesIfNoneMatch(headers['if-none-match'], result.artifactEtag)) {
      response.status(304).end();
      return;
    }
    response.type(artifact.mimeType).status(200).send(artifact.bytes);
  }

  private setDeliveryHeaders(response: Response, result: Awaited<ReturnType<PullContentService['read']>>, etag: string) {
    if (result.manifest.timerState) response.setHeader('X-Server-Time', result.manifest.timerState.serverTime);
    response.set({ ETag: etag, 'Cache-Control': 'private, no-cache',
      'X-Refresh-After-Seconds': String(result.hints.refreshAfterSeconds), 'X-Delivery-Mode': result.deliveryMode });
    response.vary('Authorization, HTTP_ID, Access-Token');
  }
}
