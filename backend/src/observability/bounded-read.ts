/** Keep the owning read occupied until every started query has actually settled. */
export async function readBatch<T extends readonly unknown[]>(tasks: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const results = await Promise.allSettled(tasks);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as { -readonly [P in keyof T]: Awaited<T[P]> };
}

/** A timed-out diagnostic read must not enqueue more work on every scrape. */
export class BoundedRead {
  private pending?: Promise<unknown>;

  async run<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.pending) throw new Error('OBSERVABILITY_READ_BUSY');
    const abort = new AbortController();
    const task = Promise.resolve().then(() => read(abort.signal));
    this.pending = task;
    const clear = () => { if (this.pending === task) this.pending = undefined; };
    void task.then(clear, clear);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([task, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error('OBSERVABILITY_READ_TIMEOUT'));
        }, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
