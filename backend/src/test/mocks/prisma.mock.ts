import { createMock } from './helpers';

/**
 * Creates a mock PrismaService with common model operations
 */
export function createMockPrisma() {
  const createModelMock = () => ({
    findFirst: createMock(),
    findUnique: createMock(),
    findMany: createMock(),
    create: createMock(),
    update: createMock(),
    updateMany: createMock(),
    upsert: createMock(),
    delete: createMock(),
    deleteMany: createMock(),
    count: createMock(),
  });

  return {
    device: createModelMock(),
    screen: createModelMock(),
    screenDesign: createModelMock(),
    screenWidget: createModelMock(),
    playlist: createModelMock(),
    playlistItem: createModelMock(),
    customWidget: createModelMock(),
    dataSource: createModelMock(),
    setting: createModelMock(),
    firmware: createModelMock(),
    extension: createModelMock(),
    event: createModelMock(),
    model: createModelMock(),
    deviceLog: createModelMock(),
    deviceCredential: createModelMock(),
    deviceEnrollment: createModelMock(),
    adminAccount: createModelMock(),
    adminCredential: createModelMock(),
    adminSession: createModelMock(),
    deviceProfile: createModelMock(),
    deliveryPolicy: createModelMock(),
    publication: createModelMock(),
    publicationRevision: createModelMock(),
    devicePublicationState: createModelMock(),
    outboxEvent: createModelMock(),
    blockedDevice: createModelMock(),
    widgetTemplate: createModelMock(),
    $transaction: createMock().mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') return fn(createMockPrisma());
      return Promise.all(fn);
    }),
    $queryRaw: createMock(),
  };
}

export type MockPrisma = ReturnType<typeof createMockPrisma>;
