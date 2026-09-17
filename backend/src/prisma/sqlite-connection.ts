/** SQLite has one writer. Queue contention in Prisma's async pool rather than
 * letting synchronous SQLite busy waits exhaust the engine's worker threads.
 * Keep one connection per process; API and worker still use separate clients.
 */
export function sqliteConnectionUrl(url: string): string {
  const separator = url.indexOf('?');
  const location = separator < 0 ? url : url.slice(0, separator);
  const parameters = new URLSearchParams(separator < 0 ? '' : url.slice(separator + 1));
  parameters.set('connection_limit', '1');
  return `${location}?${parameters.toString()}`;
}
