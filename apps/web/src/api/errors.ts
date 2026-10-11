import { ERRORS, type ApiErrorBody, type ErrorCode } from '@nuzli/shared';
import { t } from '../i18n';

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'UNKNOWN';

/** One error type for both adapters: what the API said, in Arabic, plus field errors. */
export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly message_ar: string;
  readonly details?: unknown;

  constructor(status: number, code: ClientErrorCode, message_ar: string, details?: unknown) {
    super(message_ar);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.message_ar = message_ar;
    this.details = details;
  }

  static fromBody(status: number, body: Partial<ApiErrorBody> | null | undefined): ApiError {
    const code = (body?.code ?? (status >= 500 ? 'INTERNAL' : 'UNKNOWN')) as ClientErrorCode;
    const message =
      body?.message_ar ?? (code in ERRORS ? ERRORS[code as ErrorCode] : t('error.unknown'));
    return new ApiError(status, code, message, body?.details);
  }

  static of(code: ErrorCode, status: number, details?: unknown): ApiError {
    return new ApiError(status, code, ERRORS[code], details);
  }

  /** `details.fieldErrors` from a 400 VALIDATION_FAILED, or the field implied by a uniqueness code. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    const d = this.details as { fieldErrors?: Record<string, string[] | string> } | undefined;
    if (d?.fieldErrors) {
      for (const [k, v] of Object.entries(d.fieldErrors)) {
        const msg = Array.isArray(v) ? v[0] : v;
        if (msg) out[k] = msg;
      }
    }
    const implied: Partial<Record<ClientErrorCode, string>> = {
      EMAIL_TAKEN: 'email',
      MOBILE_TAKEN: 'mobile',
      NATIONAL_ID_TAKEN: 'nationalId',
      REJECTION_REASON_REQUIRED: 'reason',
    };
    const field = implied[this.code];
    if (field && !out[field]) out[field] = this.message_ar;
    return out;
  }
}

/** The Arabic message to show for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message_ar;
  return t('error.unknown');
}
