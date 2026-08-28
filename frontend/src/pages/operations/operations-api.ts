import axios from 'axios';
import { parseOperationsStatus, type OperationsStatus } from '@inker/contracts';
import apiClient from '../../services/api';

type ErrorCode = 'unavailable' | 'invalid-response' | 'session-expired' | 'forbidden' | 'request-failed';
export class OperationsApiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(code); this.code = code; }
}
export function operationsErrorMessage(error: unknown): string {
  const code = error instanceof OperationsApiError ? error.code : 'request-failed';
  const messages: Record<ErrorCode, string> = {
    unavailable: 'Operations diagnostics are unavailable on this server (404).',
    'invalid-response': 'The server returned invalid operations metadata.',
    'session-expired': 'Your admin session has expired. Sign in again.',
    forbidden: 'Operations diagnostics require an authorized admin session.',
    'request-failed': 'Operations diagnostics could not be refreshed.',
  };
  return messages[code];
}
export async function readOperations(signal: AbortSignal): Promise<OperationsStatus> {
  try {
    const response = await apiClient.get<{ data: unknown }>('/operations', { signal, timeout: 8000 });
    const parsed = parseOperationsStatus(response.data.data);
    if (!parsed.success) throw new OperationsApiError('invalid-response');
    return parsed.data;
  } catch (error) {
    if (error instanceof OperationsApiError) throw error;
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    // Never display response bodies, arbitrary error messages or request headers.
    throw new OperationsApiError(status === 404 ? 'unavailable' : status === 401 ? 'session-expired'
      : status === 403 ? 'forbidden' : 'request-failed');
  }
}
