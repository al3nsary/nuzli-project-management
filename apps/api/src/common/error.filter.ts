import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { errorBody, type ApiErrorBody, type ErrorCode } from '@nuzli/shared';
import type { Response } from 'express';
import { AppError } from './app-error';
import { mapPrismaError } from './prisma-errors';

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT_VERSION',
  413: 'FILE_TOO_LARGE',
  415: 'FILE_TYPE_NOT_ALLOWED',
  429: 'RATE_LIMITED',
};

/** Converts any thrown value to `{ status, body }` with the single API error shape. */
export function toErrorResponse(exception: unknown): { status: number; body: ApiErrorBody } {
  const mapped = exception instanceof AppError ? exception : mapPrismaError(exception);
  if (mapped) {
    return { status: mapped.status, body: errorBody(mapped.code, mapped.details) };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED');
    return { status, body: errorBody(code) };
  }
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: errorBody('INTERNAL') };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = toErrorResponse(exception);
    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    if (res.headersSent) return;
    res.status(status).json(body);
  }
}
