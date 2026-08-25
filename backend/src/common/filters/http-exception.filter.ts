import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { redactLogValue, redactSecretText } from '../../config/secret-redaction';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';
    const safeMessage = redactLogValue(message);

    const safePath = this.sanitizeUrl(request.url);

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: safePath,
      method: request.method,
      message: typeof safeMessage === 'string' ? safeMessage : (safeMessage as any).message,
      ...(typeof safeMessage === 'object' && safeMessage !== null ? safeMessage : {}),
    };

    // Log error details (query params stripped to prevent token leakage)
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${safePath}`,
        redactSecretText(
          exception instanceof Error ? exception.stack || exception.message : JSON.stringify(exception),
        ),
      );
    } else {
      this.logger.warn(
        `${request.method} ${safePath} - ${JSON.stringify(errorResponse)}`,
      );
    }

    response.status(status).json(errorResponse);
  }

  /** Strip query parameters from URL to prevent token leakage in logs */
  private sanitizeUrl(url: string): string {
    const qIndex = url.indexOf('?');
    return qIndex >= 0 ? url.substring(0, qIndex) : url;
  }
}
