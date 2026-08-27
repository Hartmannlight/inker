// Independent Node process, real Prisma client and production TypeScript sources.
const fs = require('node:fs');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true },
}).outputText, filename);
const { PrismaClient } = require('@prisma/client');
const { PlaybackService } = require('../../src/playback/playback.service');
const { PublicationPersistenceService } = require('../../src/publications/publication-persistence.service');
async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } });
  const service = new PlaybackService(p, new PublicationPersistenceService(p), { now: () => input.now });
  try {
    let result;
    if (input.operation === 'read') result = await service.read(input.deviceId);
    if (input.operation === 'command') result = await service.execute(input.deviceId, input.body);
    if (input.operation === 'due') {
      const event = await p.outboxEvent.findUniqueOrThrow({ where: { eventId: input.eventId } });
      result = await service.advanceDue(event);
      // Simulate abrupt death after domain commit, before the event acknowledgement.
      if (input.crashAfterCommit) process.exit(73);
    }
    process.stdout.write(JSON.stringify({ result: result ?? null }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.getStatus?.() ?? 'FAILED' }));
  } finally { await p.$disconnect(); }
}
main().catch(() => process.exit(1));
