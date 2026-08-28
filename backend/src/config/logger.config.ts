import * as winston from 'winston';
import { join } from 'node:path';
import { SafeLogger, safeLogRecord, type LogRole } from './safe-logger';

export { logStartupFailure } from './safe-logger';
export const LOG_FILE_POLICY = Object.freeze({ maxBytes: 5 * 1024 * 1024, filesPerStream: 3 });

/** JSON is the production/default wire format. Simple is explicit local debugging only. */
export function createLoggerConfig(role: LogRole = 'api', logDirectory = 'logs'): winston.LoggerOptions {
  const safeRole = role === 'worker' ? 'worker' : 'api';
  const level = ['error', 'warn', 'info', 'debug', 'verbose'].includes(process.env.LOG_LEVEL ?? '') ? process.env.LOG_LEVEL : 'info';
  const formatter = () => winston.format.combine(
    winston.format(info => safeLogRecord(info, safeRole) as typeof info)(),
    process.env.LOG_FORMAT === 'simple' ? winston.format.simple() : winston.format.json(),
  );
  const file = (name: string, error = false) => new winston.transports.File({
    filename: join(logDirectory, `${safeRole}-${name}.log`),
    ...(error ? { level: 'error' } : {}),
    maxsize: LOG_FILE_POLICY.maxBytes,
    maxFiles: LOG_FILE_POLICY.filesPerStream,
    tailable: true,
    options: { flags: 'a', mode: 0o600 },
    format: formatter(),
  });
  return {
    level,
    exitOnError: false,
    transports: [
      new winston.transports.Console({
        format: formatter(),
      }),
      ...(process.env.NODE_ENV === 'production'
        ? [file('error', true), file('combined')]
        : []),
    ],
  };
}

/** The wrapper sanitizes before Winston can read properties or format arguments. */
export function createSafeLogger(role: LogRole = 'api'): SafeLogger {
  const sink = winston.createLogger(createLoggerConfig(role));
  sink.on('error', () => undefined);
  return new SafeLogger(sink, role);
}
