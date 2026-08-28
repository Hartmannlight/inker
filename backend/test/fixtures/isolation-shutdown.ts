import {
  closeIsolatedExecution, executeIsolated, isolationDiagnostics,
} from '../../src/isolation/isolated-executor';
import { ISOLATION_LIMITS, type IsolatedRequest } from '../../src/isolation/isolation-contract';

// A separate process keeps the executor's terminal closing flag out of bun:test.
const request: IsolatedRequest = { version: 1, kind: 'javascript', code: 'while(true){}', data: null };
const watchdog = setTimeout(() => {
  // These PIDs belong exclusively to this fixture; never enumerate host processes.
  for (const pid of isolationDiagnostics().pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* Already closed. */ }
  }
  process.exit(2);
}, ISOLATION_LIMITS.wallMs * 2);

async function main() {
  const jobs = Array.from({ length: ISOLATION_LIMITS.concurrency + 2 }, () => executeIsolated(request)
    .then(() => 'unexpected-success', error => error.code));
  const before = isolationDiagnostics();
  // Concurrent shutdown calls must both wait for real process closure.
  await Promise.all([closeIsolatedExecution(), closeIsolatedExecution()]);
  const codes = await Promise.all(jobs);
  const after = isolationDiagnostics();
  const afterCloseCode = await executeIsolated(request).then(() => 'unexpected-success', error => error.code);
  process.stdout.write(JSON.stringify({ before, codes, after, afterCloseCode }));
}

void main().catch(() => { process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
