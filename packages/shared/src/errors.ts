/** Machine-readable error codes shared by API responses and the web client. */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  CSRF_REJECTED: 'CSRF_REJECTED',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Shape of every non-2xx JSON response from the API. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level validation issues, when code === VALIDATION_FAILED. */
    issues?: Array<{ path: string; message: string }>;
    requestId?: string;
  };
}
