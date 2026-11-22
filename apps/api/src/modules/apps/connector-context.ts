import { AuthError, ConnectorError, FatalError, RetryableError } from '@flowforge/connector-sdk';
import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@flowforge/shared';
import { ApiException } from '../../common/api-exception';

/** Translate connector errors raised during API-side calls (tests, option loaders) to HTTP errors. */
export function connectorErrorToHttp(err: unknown, what: string): ApiException {
  if (err instanceof ApiException) return err;
  if (err instanceof AuthError) {
    return new ApiException(HttpStatus.BAD_REQUEST, ErrorCode.BAD_REQUEST, `${what}: ${err.message}`);
  }
  if (err instanceof RetryableError || err instanceof FatalError || err instanceof ConnectorError) {
    return new ApiException(HttpStatus.BAD_GATEWAY, ErrorCode.UPSTREAM_ERROR, `${what}: ${err.message}`);
  }
  return new ApiException(HttpStatus.BAD_GATEWAY, ErrorCode.UPSTREAM_ERROR, `${what}: ${(err as Error)?.message ?? 'unknown error'}`);
}

/** Abort API-side connector calls that hang. */
export const API_CONNECTOR_TIMEOUT_MS = 20_000;
