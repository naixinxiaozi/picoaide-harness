/**
 * API 错误码与统一错误信封（与现有 server 契约一致）。
 * 信封：{"error":{"code","message"}}，HTTP 状态由 code 映射。
 */

export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'AUTH_FAILED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'UPSTREAM',
  'RATE_LIMITED',
  'INTERNAL',
  'PASSWORD_CHANGE_REQUIRED',
  'BALANCE_EXHAUSTED',
  'APPROVED_NOT_REJECTABLE',
  'APP_DELISTED',
  'MODEL_NOT_PRICED',
  'CSRF_EXPIRED',
  'AUDITOR_NOT_ALLOWED',
  'CONFLICT',
  'ARCHIVE_INVALID',
  'ARCHIVE_CLEARED',
  'NAME_TAKEN',
  'INVALID_APP_ID',
  'APP_LOCKED',
  'OFFICIAL_LOCKED',
  'PAYLOAD_TOO_LARGE',
  'UPSTREAM_ERROR',
  'SERVER',
  'METERING_FAILED',
  'MODEL_ROUTING_UNAVAILABLE',
  'FILE_BUSY',
  'FILE_RECLAIMED',
  'VERSION_EXISTS',
  'VERSION_NOT_INCREASING',
  'CONTENT_UNCHANGED',
  'INVALID_VERSION',
  'MANIFEST_MISMATCH',
  'MISSING_FIELD',
  'PENDING_LIMIT',
  'PUBLISH_BUSY',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** code → HTTP status 映射（唯一真源）。 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  AUTH_REQUIRED: 401,
  AUTH_FAILED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  UPSTREAM: 502,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  PASSWORD_CHANGE_REQUIRED: 403,
  BALANCE_EXHAUSTED: 429,
  APPROVED_NOT_REJECTABLE: 409,
  APP_DELISTED: 409,
  MODEL_NOT_PRICED: 429,
  CSRF_EXPIRED: 403,
  AUDITOR_NOT_ALLOWED: 401,
  CONFLICT: 409,
  ARCHIVE_INVALID: 422,
  ARCHIVE_CLEARED: 409,
  NAME_TAKEN: 409,
  INVALID_APP_ID: 422,
  APP_LOCKED: 403,
  OFFICIAL_LOCKED: 403,
  PAYLOAD_TOO_LARGE: 413,
  UPSTREAM_ERROR: 502,
  SERVER: 503,
  METERING_FAILED: 503,
  MODEL_ROUTING_UNAVAILABLE: 429,
  FILE_BUSY: 409,
  FILE_RECLAIMED: 409,
  VERSION_EXISTS: 409,
  VERSION_NOT_INCREASING: 409,
  CONTENT_UNCHANGED: 409,
  INVALID_VERSION: 422,
  MANIFEST_MISMATCH: 422,
  MISSING_FIELD: 422,
  PENDING_LIMIT: 429,
  PUBLISH_BUSY: 503,
};

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get status(): number {
    return this.httpStatus ?? ERROR_HTTP_STATUS[this.code];
  }

  /** 序列化为契约信封体。 */
  toBody(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

/** 便捷构造：泛化 500。 */
export function internal(message = 'internal error'): ApiError {
  return new ApiError('INTERNAL', message);
}
