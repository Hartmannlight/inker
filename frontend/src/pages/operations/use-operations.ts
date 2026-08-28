import { useCallback, useEffect, useRef, useState } from 'react';
import type { OperationsStatus } from '@inker/contracts';
import { OperationsApiError, operationsErrorMessage, readOperations } from './operations-api';

export function useOperations() {
  const [snapshot, setSnapshot] = useState<OperationsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let alive = true, request: AbortController | null = null, receivedAt: number | null = null, denied = false;
    const load = async () => {
      if (!alive || request) return;
      const current = new AbortController(); request = current;
      setBusy(true);
      try {
        const result = await readOperations(current.signal);
        if (!alive || current.signal.aborted) return;
        receivedAt = performance.now(); denied = false;
        setSnapshot(result); setElapsed(0); setError(null);
      } catch (failure) {
        if (!alive || current.signal.aborted) return;
        denied = failure instanceof OperationsApiError && ['session-expired', 'forbidden'].includes(failure.code);
        if (denied) { setSnapshot(null); receivedAt = null; setElapsed(0); }
        setError(operationsErrorMessage(failure));
      } finally {
        request = null;
        if (alive) setBusy(false);
      }
    };
    refreshRef.current = () => { void load(); };
    const visible = () => {
      if (document.visibilityState === 'visible' && !denied) void load();
    };
    const timer = window.setInterval(() => {
      if (receivedAt !== null) setElapsed(Math.max(0, performance.now() - receivedAt));
      visible();
    }, 15000);
    document.addEventListener('visibilitychange', visible);
    void load();
    return () => {
      alive = false; request?.abort();
      window.clearInterval(timer); document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return { snapshot, error, busy, elapsed, refresh };
}
