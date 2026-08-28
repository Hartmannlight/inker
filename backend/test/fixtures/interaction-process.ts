import { PrismaClient } from '@prisma/client';
import type { IncomingHttpHeaders } from 'node:http';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PublicationPersistenceService } from '../../src/publications/publication-persistence.service';
import { PlaybackService } from '../../src/playback/playback.service';
import { ArtifactStore } from '../../src/render-cache/artifact-store';
import { RenderCacheService } from '../../src/render-cache/render-cache.service';
import { InteractionService } from '../../src/interactions/interaction.service';
import { CommandRegistry } from '../../src/interactions/command-registry';
import { ViewNextHandler } from '../../src/interactions/view-next.handler';

// An independent process with its own Prisma client proves SQLite owns replay.
// Credentials enter only stdin, never process arguments or fixture error output.
const buffers: Uint8Array[] = [];
let size = 0;
for await (const chunk of Bun.stdin.stream()) {
  size += chunk.byteLength;
  if (size > 16_384) throw new Error('INTERACTION_FIXTURE_INPUT_LIMIT');
  buffers.push(chunk);
}
const input = JSON.parse(Buffer.concat(buffers).toString()) as {
  url: string; now: number; headers: IncomingHttpHeaders; event: unknown;
};
const p = new PrismaClient({ datasources: { db: { url: input.url } } });
try {
  const persistence = new PublicationPersistenceService(p as PrismaService);
  const playback = new PlaybackService(p as PrismaService, persistence, { now: () => input.now });
  const service = new InteractionService(p as PrismaService, new CommandRegistry([new ViewNextHandler(playback)]),
    new RenderCacheService(p as PrismaService, new ArtifactStore()), { now: () => input.now });
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await service.execute(input.headers, input.event);
      process.stdout.write(JSON.stringify(result));
      break;
    } catch (error) {
      if (attempt >= 4 || (error as { getStatus?(): number }).getStatus?.() !== 503)
        throw new Error('INTERACTION_FIXTURE_EXECUTION_FAILED');
      await Bun.sleep(50 * (attempt + 1));
    }
  }
} finally { await p.$disconnect(); }
