import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';
import { initializeInstanceSecrets } from '../../src/config/instance-secrets';
/** Real service wiring for fixture-image integration tests. Browser rendering must be explicit. */
import { PublishService as ProductionPublisher } from '../../src/publications/publish.service';
import { PlaybackService as ProductionPlayback } from '../../src/playback/playback.service';
import { PresentationService as ProductionPresentation } from '../../src/device-platform/presentation.service';
import { DeviceArtifactResolverService } from '../../src/device-platform/device-artifact-resolver.service';
import { DynamicDesignArtifactService } from '../../src/device-platform/dynamic-design-artifact.service';
import { PullArtifactLeaseService } from '../../src/device-platform/pull-artifact-lease.service';
import { RenderCacheService } from '../../src/render-cache/render-cache.service';
import { ArtifactStore } from '../../src/render-cache/artifact-store';
import { PrismaService } from '../../src/prisma/prisma.service';

function unsupported<T extends object>(name: string): T {
  return new Proxy({} as T, { get() { throw new Error(`Fixture requires an explicit ${name}`); } });
}

export class PublishService extends ProductionPublisher {
  constructor(prisma: PrismaService, persistence: ConstructorParameters<typeof ProductionPublisher>[1],
    renderer = unsupported<ConstructorParameters<typeof ProductionPublisher>[2]>('screen renderer'),
    recipes = unsupported<ConstructorParameters<typeof ProductionPublisher>[3]>('recipe service')) {
    super(prisma, persistence, renderer, recipes);
  }
}

export class PlaybackService extends ProductionPlayback {
  constructor(prisma: PrismaService, persistence: ConstructorParameters<typeof ProductionPlayback>[1],
    clock: ConstructorParameters<typeof ProductionPlayback>[2], publisher = new PublishService(prisma, persistence)) {
    super(prisma, persistence, clock, publisher);
  }
}

export function fixtureArtifacts(prisma: PrismaService, cache = new RenderCacheService(prisma, new ArtifactStore())) {
  return new DeviceArtifactResolverService(prisma, cache,
    new DynamicDesignArtifactService(prisma, unsupported('screen renderer')));
}

export class PresentationService extends ProductionPresentation {
  constructor(prisma: PrismaService, cache = new RenderCacheService(prisma, new ArtifactStore())) {
    super(prisma, new DeviceArtifactResolverService(prisma, cache,
      new DynamicDesignArtifactService(prisma, unsupported('screen renderer'))), new PullArtifactLeaseService());
  }
}

export function fixtureConfig(directory: string) {
  const secretPath = join(directory, 'secrets', 'instance.json');
  initializeInstanceSecrets({ secretPath, databasePath: join(directory, 'test.db'), allowExistingDatabase: true });
  return ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ encryption: { secretPath } })] });
}
