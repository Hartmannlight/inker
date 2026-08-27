// Node hosts ws/Nest; the Bun test runner owns the temporary SQLite database.
const fs = require('node:fs');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true },
}).outputText, filename);
const { PrismaClient } = require('@prisma/client');
const { Test } = require('@nestjs/testing');
const { OutboxModule } = require('../../src/events/outbox.module');
const { PrismaService } = require('../../src/prisma/prisma.service');
const { OutboxDispatcher } = require('../../src/events/outbox-dispatcher.service');
const { OutboxRedisService } = require('../../src/events/outbox-redis.service');
const { OutboxStore } = require('../../src/events/outbox.store');
const { EventsService } = require('../../src/events/events.service');
const { DeviceUpdateCoordinator } = require('../../src/device-platform/device-update-coordinator.service');
const { WebSocketTransportAdapter } = require('../../src/device-platform/websocket.transport-adapter');
const { PublishService } = require('../../src/publications/publish.service');
const { PlaybackService } = require('../../src/playback/playback.service');

async function main() {
  const p = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const module = await Test.createTestingModule({ imports: [OutboxModule] }).overrideProvider(PrismaService).useValue(p).compile();
  const app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  process.send({ ready: true, url: `ws://127.0.0.1:${app.getHttpServer().address().port}/api/device-connect` });
  process.on('message', async ({ id, command, deviceId, designId }) => {
    try {
      if (command === 'notify') await app.get(EventsService).notifyDevicesRefresh([deviceId]);
      if (command === 'playback-start') {
        const playback = app.get(PlaybackService);
        const revisions = await p.publicationRevision.findMany({ orderBy: { revision: 'asc' }, take: 2 });
        const playlist = await p.playlist.create({ data: { name: 'WP18', items: { create: [{ order: 0, duration: 2 }, { order: 1, duration: null }] } }, include: { items: { orderBy: { order: 'asc' } } } });
        const published = await playback.publish(playlist.id, { version: 1, idempotencyKey: require('node:crypto').randomUUID(), expectedRevision: 0,
          expectedDraftHash: (await playback.draft(playlist.id)).draftHash,
          bindings: playlist.items.map((item, i) => ({ itemId: item.id, publicationRevisionId: revisions[i].publicationRevisionId })) });
        const desired = await p.devicePublicationState.findUniqueOrThrow({ where: { deviceId } });
        await playback.execute(deviceId, { version: 1, idempotencyKey: id, action: 'start', expectedVersion: 0,
          expectedDesiredSequence: desired.desiredSequence, playlistRevisionId: published.playlistRevisionId });
      }
      if (command === 'publish') {
        const latest = await p.publication.findUnique({ where: { publicationKey: 'system-test' }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } });
        await app.get(PublishService).publish('system-test', { idempotencyKey: id, expectedRevision: latest?.revisions[0]?.revision ?? 0,
          draft: { fixtureArtifacts: ['mono-800x480-white-png'] }, deviceIds: [deviceId] });
      }
      if (command === 'design') await app.get(EventsService).notifyScreenDesignUpdate(designId);
      if (command === 'subscriber-off') app.get(OutboxRedisService).subscriber.disconnect();
      if (command === 'subscriber-on') await app.get(OutboxRedisService).subscriber.connect();
      if (command === 'pause') {
        const dispatcher = app.get(OutboxDispatcher); dispatcher.stopped = true;
        await app.get(OutboxRedisService).worker.pause();
      }
      if (command === 'fail-once') {
        const adapter = app.get(WebSocketTransportAdapter), original = adapter.dispatchRefresh.bind(adapter);
        let first = true;
        adapter.dispatchRefresh = (...args) => { if (first) { first = false; throw new Error('credential-test-secret-do-not-log'); } return original(...args); };
      }
      if (command === 'crash-before-ack') {
        const store = app.get(OutboxStore), ack = store.ack.bind(store);
        store.ack = async (...args) => {
          if (args[0].eventType === 'device.publication.desired-revision.changed') process.exit(73);
          return ack(...args);
        };
      }
      if (command === 'lose-target-ack-once') {
        const store = app.get(OutboxStore), finish = store.finishTarget.bind(store);
        let first = true;
        store.finishTarget = async (...args) => { if (first && args[3] && await p.outboxDelivery.count({ where: { effectKey: args[0] } })) { first = false; return false; } return finish(...args); };
      }
      if (command === 'stop') {
        await app.close(); await p.$disconnect(); process.send({ id }); process.exit(0);
      }
      process.send({ id, consumerId: app.get(DeviceUpdateCoordinator).consumerId });
    } catch { process.send({ id, error: 'TEST_COMMAND_FAILED' }); }
  });
}
main().catch(() => { console.error('OUTBOX_TEST_HOST_FAILED'); process.exit(1); });
