import { utilities as nestWinstonModuleUtilities } from 'nest-winston';
import * as winston from 'winston';
import { redactLogValue } from './secret-redaction';

const redactFormat = winston.format((info) => redactLogValue(info) as typeof info);

export function createLoggerConfig() {
  const format = process.env.LOG_FORMAT === 'simple'
    ? winston.format.simple()
    : winston.format.json();

  return {
    transports: [
      new winston.transports.Console({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(
          redactFormat(),
          winston.format.timestamp(),
          winston.format.ms(),
          nestWinstonModuleUtilities.format.nestLike('Inker', {
            prettyPrint: process.env.NODE_ENV !== 'production',
          }),
        ),
      }),
      ...(process.env.NODE_ENV === 'production'
        ? [
            new winston.transports.File({
              filename: 'logs/error.log',
              level: 'error',
              format: winston.format.combine(redactFormat(), format),
            }),
            new winston.transports.File({
              filename: 'logs/combined.log',
              format: winston.format.combine(redactFormat(), format),
            }),
          ]
        : []),
    ],
  };
}
