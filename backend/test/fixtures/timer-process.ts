import { PrismaClient } from '@prisma/client';
import type { IncomingHttpHeaders } from 'node:http';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ArtifactStore } from '../../src/render-cache/artifact-store';
import { RenderCacheService } from '../../src/render-cache/render-cache.service';
import { InteractionService } from '../../src/interactions/interaction.service';
import { CommandRegistry } from '../../src/interactions/command-registry';
import { TimerService } from '../../src/timers/timer.service';
import { TIMER_ACTIONS, TimerCommandHandler } from '../../src/timers/timer-handlers';

// A separate client/process checks durable receipt and version fences. Keep
// bearer credentials out of command-line arguments and fixture diagnostics.
const chunks: Uint8Array[] = [];
let bytes = 0;
for await (const chunk of Bun.stdin.stream()) {
  bytes += chunk.byteLength;
  if (bytes > 16_384) throw new Error('TIMER_FIXTURE_INPUT_LIMIT');
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString()) as {
  url: string; now: number; headers: IncomingHttpHeaders; event: unknown;
};
const p = new PrismaClient({ datasources: { db: { url: input.url } } });
try {
  const timers = new TimerService(p as PrismaService, { now: () => input.now });
  const service = new InteractionService(p as PrismaService,
    new CommandRegistry(TIMER_ACTIONS.map(action => new TimerCommandHandler(action, timers))),
    new RenderCacheService(p as PrismaService, new ArtifactStore()), { now: () => input.now });
  for (let attempt = 0; ; attempt++) {
    try {
      process.stdout.write(JSON.stringify(await service.execute(input.headers, input.event)));
      break;
    } catch (error) {
      if (attempt >= 4 || (error as { getStatus?(): number }).getStatus?.() !== 503)
        throw new Error('TIMER_FIXTURE_EXECUTION_FAILED');
      await Bun.sleep(50 * (attempt + 1));
    }
  }
} finally { await p.$disconnect(); }
