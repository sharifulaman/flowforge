/**
 * Errors connectors throw to steer the engine. Anything else thrown is treated as
 * retryable if it looks like a network error, otherwise fatal.
 */
export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'CONNECTOR_ERROR',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Transient failure (5xx, 429, timeout). The engine retries with backoff. */
export class RetryableError extends ConnectorError {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
    details?: unknown,
  ) {
    super(message, 'RETRYABLE', details);
  }
}

/** Permanent failure (bad input, 4xx). The run fails without retrying. */
export class FatalError extends ConnectorError {
  constructor(message: string, code = 'FATAL', details?: unknown) {
    super(message, code, details);
  }
}

/** Credentials are invalid/revoked. Fails the step and flags the connection. */
export class AuthError extends FatalError {
  constructor(message = 'Authentication failed — reconnect this account', details?: unknown) {
    super(message, 'AUTH_FAILED', details);
  }
}

/** Ends the run successfully-but-stopped (status FILTERED), e.g. a Filter step whose condition is false. */
export class StopRun extends ConnectorError {
  constructor(public readonly reason: string) {
    super(reason, 'STOPPED');
  }
}

/**
 * Pause the run and resume this step at `resumeAt` (used by Delay). The engine frees the
 * worker slot; when the run resumes, the suspending step completes with `{ resumedAt }`.
 */
export class SuspendRun extends ConnectorError {
  constructor(public readonly resumeAt: Date) {
    super(`Suspended until ${resumeAt.toISOString()}`, 'SUSPENDED');
  }
}
