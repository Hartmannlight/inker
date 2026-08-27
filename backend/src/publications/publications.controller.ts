import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { PublishService } from './publish.service';
import { PublicationPersistenceService } from './publication-persistence.service';

// Deliberately not @Public: existing admin sessions and CSRF protect commands.
@Controller('publications')
export class PublicationsController {
  constructor(private readonly publisher: PublishService, private readonly persistence: PublicationPersistenceService) {}

  @Post(':key/publish')
  publish(@Param('key') key: string, @Body() body: unknown) { return this.publisher.publish(key, body); }

  @Put('devices/:deviceId/desired')
  assign(@Param('deviceId', ParseIntPipe) deviceId: number, @Body() body: unknown) { return this.publisher.assign(deviceId, body); }

  @Get(':key')
  async read(@Param('key') key: string) {
    const publication = await this.persistence.getPublication(key);
    if (!publication) throw new NotFoundException('Publication not found');
    return { publicationId: publication.publicationId, publicationKey: publication.publicationKey,
      revisions: publication.revisions.map(r => ({ publicationRevisionId: r.publicationRevisionId, revision: r.revision, contentHash: r.contentHash, publishedAt: r.publishedAt })) };
  }
}
