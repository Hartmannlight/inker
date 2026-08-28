import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JsonValue } from '@inker/contracts';
import {
  cloneIsolatedJson, ISOLATION_ERROR_CODES, ISOLATION_LIMITS, IsolatedExecutionError,
  validateIsolatedRequest, type IsolatedRequest, type IsolationErrorCode,
} from './isolation-contract';

export { IsolatedExecutionError } from './isolation-contract';
type Task = {
  request: IsolatedRequest; input: string; deadline: number; signal?: AbortSignal;
  resolve: (value: JsonValue) => void; reject: (error: IsolatedExecutionError) => void;
  timer?: ReturnType<typeof setTimeout>; abort?: () => void;
};
const pending: Task[] = [];
const active = new Map<Task, { child: ChildProcessWithoutNullStreams; stop: (code: IsolationErrorCode) => void; closed: Promise<void> }>();
const totals = { started: 0, completed: 0, failed: 0, killed: 0 };
let closing = false;

/** Process-local diagnostics contain no input/output, credentials or command text. */
export function isolationDiagnostics() {
  return { ...totals, active: active.size, pending: pending.length,
    pids: Array.from(active.values(), item => item.child.pid).filter((pid): pid is number => pid !== undefined) };
}

function clear(task: Task) {
  clearTimeout(task.timer);
  if (task.abort) task.signal?.removeEventListener('abort', task.abort);
}
function rejectPending(task: Task, code: IsolationErrorCode) {
  const index = pending.indexOf(task);
  if (index < 0) return;
  pending.splice(index, 1); clear(task); totals.failed++;
  task.reject(new IsolatedExecutionError(code));
}
function responseValue(raw: string, request: IsolatedRequest): JsonValue {
  let response: Record<string, unknown>;
  try { response = JSON.parse(raw); }
  catch { throw new IsolatedExecutionError('ISOLATION_INVALID_OUTPUT'); }
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.version !== 1) {
    throw new IsolatedExecutionError('ISOLATION_INVALID_OUTPUT');
  }
  if (response.ok === false && Object.keys(response).length === 3
    && ISOLATION_ERROR_CODES.includes(response.code as IsolationErrorCode)) {
    throw new IsolatedExecutionError(response.code as IsolationErrorCode);
  }
  if (response.ok !== true || Object.keys(response).length !== 3 || !Object.prototype.hasOwnProperty.call(response, 'value')) {
    throw new IsolatedExecutionError('ISOLATION_INVALID_OUTPUT');
  }
  if (request.kind === 'liquid') {
    if (typeof response.value !== 'string') throw new IsolatedExecutionError('ISOLATION_INVALID_OUTPUT');
    if (Buffer.byteLength(response.value) > ISOLATION_LIMITS.htmlBytes) throw new IsolatedExecutionError('ISOLATION_OUTPUT_LIMIT');
    return response.value;
  }
  try { return cloneIsolatedJson(response.value, ISOLATION_LIMITS.outputBytes); }
  catch { throw new IsolatedExecutionError('ISOLATION_INVALID_OUTPUT'); }
}
function start(task: Task) {
  clear(task);
  if (task.signal?.aborted || Date.now() >= task.deadline || closing) {
    totals.failed++;
    task.reject(new IsolatedExecutionError(task.signal?.aborted || closing ? 'ISOLATION_ABORTED' : 'ISOLATION_TIMEOUT'));
    return;
  }
  const sourceEntry = join(__dirname, 'isolation-child.ts');
  const entry = existsSync(sourceEntry) ? sourceEntry : join(__dirname, 'isolation-child.js');
  if (!existsSync(entry)) { totals.failed++; task.reject(new IsolatedExecutionError('ISOLATION_UNAVAILABLE')); return; }
  let child: ChildProcessWithoutNullStreams;
  try {
    // No inherited secrets, handles, working directory or Node preload options.
    // Arbitrary code executes only inside the child QuickJS guest, never in Bun.
    const args = process.versions.bun ? ['--no-env-file', entry] : [entry];
    child = spawn(process.execPath, args, { cwd: dirname(entry), env: {}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { totals.failed++; task.reject(new IsolatedExecutionError('ISOLATION_UNAVAILABLE')); return; }
  totals.started++;
  let forced: IsolationErrorCode | undefined, outputSize = 0, errorSize = 0;
  const chunks: Buffer[] = [];
  const stop = (code: IsolationErrorCode) => {
    if (forced) return;
    forced = code; totals.killed++;
    child.kill('SIGKILL');
    child.stdin.destroy();
  };
  let closeDone!: () => void;
  const closed = new Promise<void>(resolve => { closeDone = resolve; });
  active.set(task, { child, stop, closed });
  task.abort = () => stop('ISOLATION_ABORTED');
  task.signal?.addEventListener('abort', task.abort, { once: true });
  task.timer = setTimeout(() => stop('ISOLATION_TIMEOUT'), Math.max(1, task.deadline - Date.now()));
  child.on('error', () => { forced ??= 'ISOLATION_UNAVAILABLE'; });
  child.stdin.on('error', () => { /* Exit/close is authoritative; never log raw pipe errors. */ });
  child.stdout.on('data', (chunk: Buffer) => {
    outputSize += chunk.length;
    if (outputSize > ISOLATION_LIMITS.responseBytes) stop('ISOLATION_OUTPUT_LIMIT');
    else if (!forced) chunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // Guest text must never become a parent log, diagnostic or exception.
    errorSize += chunk.length;
    if (errorSize > 8192) stop('ISOLATION_OUTPUT_LIMIT');
  });
  child.on('close', (code, signal) => {
    clear(task); active.delete(task); closeDone();
    try {
      if (forced) throw new IsolatedExecutionError(forced);
      if (code !== 0 || signal) throw new IsolatedExecutionError('ISOLATION_CRASH');
      if (task.signal?.aborted || closing) throw new IsolatedExecutionError('ISOLATION_ABORTED');
      if (Date.now() >= task.deadline) throw new IsolatedExecutionError('ISOLATION_TIMEOUT');
      const value = responseValue(Buffer.concat(chunks).toString('utf8'), task.request);
      totals.completed++; task.resolve(value);
    } catch (error) {
      totals.failed++;
      task.reject(error instanceof IsolatedExecutionError ? error : new IsolatedExecutionError('ISOLATION_FAILED'));
    }
    drain();
  });
  if (task.signal?.aborted) stop('ISOLATION_ABORTED');
  else child.stdin.end(task.input);
}
function drain() {
  while (!closing && active.size < ISOLATION_LIMITS.concurrency && pending.length) start(pending.shift()!);
}

/** Only normalized JSON crosses stdin; completion waits for actual process closure. */
export async function executeIsolated(input: IsolatedRequest, signal?: AbortSignal): Promise<JsonValue> {
  if (closing || signal?.aborted) throw new IsolatedExecutionError('ISOLATION_ABORTED');
  if (pending.length >= ISOLATION_LIMITS.pending) throw new IsolatedExecutionError('ISOLATION_BUSY');
  const request = validateIsolatedRequest(input);
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > ISOLATION_LIMITS.requestBytes) throw new IsolatedExecutionError('ISOLATION_INVALID_INPUT');
  return new Promise<JsonValue>((resolve, reject) => {
    const task: Task = { request, input: serialized, deadline: Date.now() + ISOLATION_LIMITS.wallMs, signal, resolve, reject };
    task.abort = () => rejectPending(task, 'ISOLATION_ABORTED');
    task.timer = setTimeout(() => rejectPending(task, 'ISOLATION_TIMEOUT'), ISOLATION_LIMITS.wallMs);
    signal?.addEventListener('abort', task.abort, { once: true });
    pending.push(task); drain();
  });
}

export async function closeIsolatedExecution() {
  closing = true;
  for (const task of [...pending]) rejectPending(task, 'ISOLATION_ABORTED');
  const running = [...active.values()];
  for (const item of running) item.stop('ISOLATION_ABORTED');
  await Promise.all(running.map(item => item.closed));
}
