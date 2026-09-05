import {
  Body, Controller, Delete, Get, Headers, Param, Post, Req, Res,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { matchesIfNoneMatch } from '../common/utils/http-cache.util';
import { FederationFeedService } from './federation-feed.service';
import { FederationTransportGuard } from './federation-transport.guard';
import { ShareCredentialService } from './share-credential.service';

type AdminRequest = Request & { adminSession?: { adminId: string } };

@Controller('federation')
@UseGuards(FederationTransportGuard)
export class FederationController {
  constructor(private readonly shares: ShareCredentialService, private readonly feed: FederationFeedService) {}

  @Public()
  @Get('v1/capabilities')
  async capabilities(@Headers() headers: IncomingHttpHeaders, @Res() response: Response): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.feed.capabilities();
    this.deliveryHeaders(response, result.etag);
    if (matchesIfNoneMatch(headers['if-none-match'], result.etag)) {
      response.status(304).end();
      return;
    }
    response.status(200).json(result.body);
  }

  @Public()
  @Get('v1/publications/:publicationId')
  async publication(
    @Headers() headers: IncomingHttpHeaders, @Param('publicationId') publicationId: string,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const principal = await this.shares.authenticate(headers, publicationId);
    const result = await this.feed.read(principal.publicationId);
    // A revoke/expiry racing the read must deny both bodies and conditional 304s.
    await this.shares.revalidate(principal);
    this.deliveryHeaders(response, result.etag);
    if (matchesIfNoneMatch(headers['if-none-match'], result.etag)) {
      response.status(304).end();
      return;
    }
    response.status(200).json(result.body);
  }

  @Public()
  @Get('v1/publications/:publicationId/revisions/:revision/artifacts/:sha256')
  async artifact(
    @Headers() headers: IncomingHttpHeaders, @Param('publicationId') publicationId: string,
    @Param('revision') revision: string, @Param('sha256') hash: string,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const principal = await this.shares.authenticate(headers, publicationId);
    const result = await this.feed.artifact(principal.publicationId, revision, hash);
    await this.shares.revalidate(principal);
    this.deliveryHeaders(response, result.etag);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (matchesIfNoneMatch(headers['if-none-match'], result.etag)) {
      response.status(304).end();
      return;
    }
    response.type(result.mimeType).status(200).send(result.bytes);
  }

  @Post('publications/:publicationId/shares')
  async createShare(
    @Param('publicationId') publicationId: string, @Body() body: unknown,
    @Req() request: AdminRequest, @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!request.adminSession?.adminId) throw new UnauthorizedException('FEDERATION_ADMIN_REQUIRED');
    return this.shares.create(publicationId, body, request.adminSession.adminId);
  }

  @Get('publications/:publicationId/shares')
  async listShares(@Param('publicationId') publicationId: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.shares.list(publicationId);
  }

  @Delete('publications/:publicationId/shares/:credentialId')
  async revokeShare(
    @Param('publicationId') publicationId: string, @Param('credentialId') credentialId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.shares.revoke(publicationId, credentialId);
  }

  private deliveryHeaders(response: Response, etag: string): void {
    response.set({ ETag: etag, 'Cache-Control': 'private, no-cache' });
    response.vary('Authorization');
  }
}
