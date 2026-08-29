import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type Writer = { tail: Promise<unknown>; pending: number };
const writers = new WeakMap<object, Writer>();
const retryableCodes = new Set(['P1008', 'P2028', 'P2034']);

export function isRetryableSqliteWriteError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && retryableCodes.has(error.code);
}

/** Backpressure for SQLite's single writer; SQL constraints/fences still arbitrate across processes. */
export async function sqliteWrite<T>(client: object, operation: () => Promise<T>, capacityMessage = 'SQLITE_WRITE_CAPACITY'): Promise<T> {
  let writer = writers.get(client);
  if (!writer) { writer = { tail: Promise.resolve(), pending: 0 }; writers.set(client, writer); }
  if (writer.pending >= 1024) throw new ServiceUnavailableException(capacityMessage);
  writer.pending++;
  const run = writer.tail.then(async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        // Only replay fully rolled-back transactions. No connector/network work belongs here.
        if (attempt >= 2 || !isRetryableSqliteWriteError(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 + Math.random() * 75));
      }
    }
  }).finally(() => { writer.pending--; });
  writer.tail = run.catch(() => undefined);
  return run;
}

/** Source operations retain the domain error while sharing the process-wide SQLite writer. */
export function sourceWrite<T>(client: object, operation: () => Promise<T>) {
  return sqliteWrite(client, operation, 'SOURCE_WRITE_CAPACITY');
}
