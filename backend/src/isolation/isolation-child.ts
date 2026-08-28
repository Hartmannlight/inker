import { ISOLATION_LIMITS, type IsolatedResponse } from './isolation-contract';
import { runGuest } from './guest-runtime';

async function main(): Promise<IsolatedResponse> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > ISOLATION_LIMITS.requestBytes) {
        process.stdin.destroy();
        return { version: 1, ok: false, code: 'ISOLATION_INVALID_INPUT' };
      }
      chunks.push(buffer);
    }
    return await runGuest(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')));
  } catch {
    return { version: 1, ok: false, code: 'ISOLATION_INVALID_INPUT' };
  }
}

// One response only; no data, environment, stack or guest error logs.
void main().then(response => { process.stdout.write(JSON.stringify(response) + '\n'); });
