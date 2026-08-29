// Independent Node process using the real Prisma client and production sources.
const fs = require('node:fs');
const ts = require('typescript');
require('reflect-metadata');
const { ConsoleLogger, Logger } = require('@nestjs/common');
// This process reserves stdout for its single IPC response. Keep every Nest
// diagnostic and its original level/context, but send it to the separate pipe.
class StderrLogger extends ConsoleLogger {
  printMessages(messages, context, logLevel) {
    super.printMessages(messages, context, logLevel, 'stderr');
  }
}
Logger.overrideLogger(new StderrLogger());
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true },
}).outputText, filename);
const { PrismaClient } = require('@prisma/client');
const { RenderCacheService } = require('../../src/render-cache/render-cache.service');
const { ArtifactStore } = require('../../src/render-cache/artifact-store');

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.env.INKER_RENDER_CACHE_PATH = process.argv[3];
  const prisma = new PrismaClient({ datasources: { db: { url: process.argv[2] } } });
  const files = new ArtifactStore();
  if (input.crashAfterPublish) {
    const publish = files.publish.bind(files);
    files.publish = async artifact => {
      await publish(artifact);
      // Abrupt death after complete bytes are visible, before RenderCacheService
      // can commit artifact metadata, device bindings or its ready event.
      fs.writeSync(1, JSON.stringify({ phase: 'file-published', hash: artifact.sha256, sizeBytes: artifact.bytes.length }));
      process.exit(73);
    };
  }
  const service = new RenderCacheService(prisma, files);
  try {
    let result;
    if (input.operation === 'request') result = await service.request(input.deviceId);
    else if (input.operation === 'render') {
      const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { eventId: input.eventId } });
      await service.render(event);
      result = service.metrics();
    } else if (input.operation === 'read') {
      const device = await prisma.device.findUniqueOrThrow({ where: { id: input.deviceId }, include: {
        profile: true, deliveryPolicy: true, publicationState: { include: { desiredRevision: true } },
      } });
      const cached = await service.read(device, device.publicationState.desiredRevision);
      result = cached && { hash: cached.artifact.sha256, sizeBytes: cached.artifact.bytes.length,
        revision: cached.revision.revision, fallback: cached.fallback };
    } else throw new Error('Unknown test operation');
    process.stdout.write(JSON.stringify({ result: result ?? null }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.getStatus?.() ?? error.code ?? 'FAILED' }));
    process.exitCode = 1;
  } finally { await prisma.$disconnect(); }
}
main().catch(() => process.exit(1));
