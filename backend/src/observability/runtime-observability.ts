import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { createCorrelationContext, runWithCorrelation } from './correlation-context';
import { MetricsRegistry, type RenderResult } from './metrics-registry';
import { HTTP_METHODS, structuredEvent, type HttpRouteGroup, type StructuredEventCode, type StructuredEventFields } from './structured-event';

/** Process-local diagnostics only. Never use this registry as domain state. */
export const runtimeMetrics = new MetricsRegistry();
export function observeRender(result: RenderResult): void {
  try { runtimeMetrics.recordRender(result); } catch { /* Diagnostics cannot break cache reads or commits. */ }
}
const logger = new Logger('Operations');
export function emitStructuredEvent(code: StructuredEventCode, fields: StructuredEventFields): void {
  try {
    const event = structuredEvent(code, fields);
    if (event.level === 'warn') logger.warn(event); else logger.log(event);
  } catch { /* Diagnostics must not change transaction, delivery or request outcomes. */ }
}

export function requestRoute(path: string): HttpRouteGroup {
  const segment = path.split('?', 1)[0].split('/').filter(Boolean);
  if (segment[0] === 'api') segment.shift();
  const first = segment[0];
  if (first === 'live' || first === 'health' || first === 'ready') return first;
  if (first === 'device-enrollments' || (first === 'devices' && segment[2] === 'enrollments')) return 'pairing';
  if (first === 'auth' || first === 'admin-auth') return 'auth';
  if (first === 'devices') return 'devices';
  if (first === 'sources') return 'sources';
  if (first === 'publications' || first === 'playback' || first === 'timers' || first === 'interactions') return 'publications';
  if (first === 'web-displays' || first === 'display' || first === 'v1') return 'display';
  if (first === 'operations') return 'operations';
  return 'other';
}

/** Installed before body parsers/guards; caller-supplied correlation headers are ignored. */
export function observeRequest(request: Request, response: Response, next: NextFunction): void {
  const context = createCorrelationContext(), started = performance.now();
  const route = requestRoute(request.url);
  const method = HTTP_METHODS.includes(request.method as typeof HTTP_METHODS[number])
    ? request.method as typeof HTTP_METHODS[number] : 'OTHER';
  response.setHeader('X-Correlation-ID', context.correlationId);
  let recorded = false;
  const finish = () => {
    if (recorded) return;
    recorded = true;
    const durationMs = Math.min(86_400_000, Math.max(0, performance.now() - started));
    const statusCode = response.writableFinished ? response.statusCode : 499;
    try { runtimeMetrics.recordRequest(route, statusCode, durationMs); } catch { /* Diagnostic limit. */ }
    emitStructuredEvent(statusCode >= 400 ? 'REQUEST_FAILED' : 'REQUEST_COMPLETED', {
      ...context, role: 'api', route, method, durationMs, statusCode,
    });
  };
  response.once('finish', finish);
  response.once('close', finish);
  runWithCorrelation(context, next);
}
