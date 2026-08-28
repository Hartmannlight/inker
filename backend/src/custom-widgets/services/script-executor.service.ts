import { Injectable } from '@nestjs/common';
import type { JsonValue } from '@inker/contracts';
import { executeIsolated, IsolatedExecutionError } from '../../isolation/isolated-executor';

export interface ScriptResult {
  success: boolean;
  value?: unknown;
  variables?: Record<string, unknown>;
  error?: string;
}

@Injectable()
export class ScriptExecutorService {
  /** Only validated JSON crosses the disposable process/QuickJS boundary. */
  async execute(
    code: string,
    data: unknown,
    mode: 'value' | 'template',
    signal?: AbortSignal,
  ): Promise<ScriptResult> {
    try {
      // The boundary performs descriptor-safe validation before serialization;
      // never inspect, stringify or redact raw caller objects here.
      const result = await executeIsolated({
        version: 1, kind: 'javascript', code, data: (data ?? null) as JsonValue, mode,
      }, signal);
      if (mode === 'value') return { success: true, value: result };
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return { success: false, error: 'SCRIPT_EXECUTION_FAILED' };
      }
      return { success: true, variables: result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof IsolatedExecutionError ? error.code : 'SCRIPT_EXECUTION_FAILED',
      };
    }
  }
}
