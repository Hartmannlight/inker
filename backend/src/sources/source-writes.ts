import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type Writer = { tail: Promise<unknown>; pending: number };
const writers = new WeakMap<object, Writer>();

/** Backpressure for SQLite's single writer; SQL constraints/fences still arbitrate across processes. */
export async function sourceWrite<T>(client: object, operation: () => Promise<T>): Promise<T> {
  let writer = writers.get(client);
  if (!writer) { writer = { tail: Promise.resolve(), pending: 0 }; writers.set(client, writer); }
  if (writer.pending >= 1024) throw new ServiceUnavailableException('SOURCE_WRITE_CAPACITY');
  writer.pending++;
  const run = writer.tail.then(async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        // Only replay fully rolled-back transactions. No connector/network work belongs here.
        if (attempt >= 2 || !(error instanceof Prisma.PrismaClientKnownRequestError)
          || !['P1008', 'P2028', 'P2034'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 + Math.random() * 75));
      }
    }
  }).finally(() => { writer.pending--; });
  writer.tail = run.catch(() => undefined);
  return run;
}
