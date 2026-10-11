import { HttpStatus } from '@nestjs/common';
import { ERRORS, type ErrorCode } from '@nuzli/shared';

/** HTTP status for every error code. Anything not listed is a 400. */
export const ERROR_STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  TOKEN_INVALID: HttpStatus.BAD_REQUEST,
  REFRESH_REUSED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  CSRF_INVALID: HttpStatus.FORBIDDEN,
  ACCOUNT_PENDING: HttpStatus.FORBIDDEN,
  ACCOUNT_REJECTED: HttpStatus.FORBIDDEN,
  ACCOUNT_SUSPENDED: HttpStatus.FORBIDDEN,
  PASSWORD_CHANGE_REQUIRED: HttpStatus.FORBIDDEN,
  ACCOUNT_LOCKED: 423, // Locked
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT_VERSION: HttpStatus.CONFLICT,
  EMAIL_TAKEN: HttpStatus.CONFLICT,
  MOBILE_TAKEN: HttpStatus.CONFLICT,
  NATIONAL_ID_TAKEN: HttpStatus.CONFLICT,
  LAST_ADMIN: HttpStatus.CONFLICT,
  NOT_PENDING: HttpStatus.CONFLICT,
  INVALID_STATE: HttpStatus.CONFLICT,
  COLOR_TAKEN: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  FILE_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  FILE_TYPE_NOT_ALLOWED: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  FILE_NOT_UPLOADED: HttpStatus.CONFLICT,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * The one way services report a business error. The global filter turns it into
 * `{ code, message_ar, details }` with the status from ERROR_STATUS.
 */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    readonly details?: unknown,
    status?: number,
  ) {
    super(code);
    this.name = 'AppError';
    this.status = status ?? ERROR_STATUS[code] ?? HttpStatus.BAD_REQUEST;
  }

  get messageAr(): string {
    return ERRORS[this.code];
  }
}
