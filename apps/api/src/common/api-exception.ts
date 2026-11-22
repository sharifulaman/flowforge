import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@flowforge/shared';

export interface ApiIssue {
  path: string;
  message: string;
}

/** Typed HTTP error rendered by AllExceptionsFilter as `{ error: { code, message, issues } }`. */
export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: ErrorCode,
    message: string,
    public readonly issues?: ApiIssue[],
  ) {
    super(message, status);
  }

  static badRequest(message: string, issues?: ApiIssue[]) {
    return new ApiException(HttpStatus.BAD_REQUEST, ErrorCode.BAD_REQUEST, message, issues);
  }
  static validation(issues: ApiIssue[]) {
    return new ApiException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'Validation failed', issues);
  }
  static unauthenticated(message = 'Authentication required') {
    return new ApiException(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHENTICATED, message);
  }
  static forbidden(message = 'You do not have access to this resource') {
    return new ApiException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, message);
  }
  static notFound(what = 'Resource') {
    return new ApiException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, `${what} not found`);
  }
  static conflict(message: string) {
    return new ApiException(HttpStatus.CONFLICT, ErrorCode.CONFLICT, message);
  }
}
