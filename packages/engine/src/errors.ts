import { AuthError, ConnectorError, FatalError, RetryableError, StopRun, SuspendRun } from '@flowforge/connector-sdk';
import { TemplateSyntaxError, UnknownFilterError, type RunError } from '@flowforge/shared';
import { DecryptionError } from '@flowforge/shared/node';
import { ConnectionNotFoundError } from './credentials';

export type ErrorClass =
  | { kind: 'retry'; error: RunError; retryAfterMs?: number }
  | { kind: 'fatal'; error: RunError }
  | { kind: 'auth'; error: RunError }
  | { kind: 'stop'; reason: string }
  | { kind: 'suspend'; resumeAt: Date };

/** Raised by the step runner when a step exceeds its timeout. Retryable. */
export class StepTimeoutError extends RetryableError {
  constructor(ms: number) {
    super(`Step timed out after ${Math.round(ms / 1000)}s`);
  }
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

function codeOf(err: unknown): string | undefined {
  const c = (err as { code?: unknown })?.code;
  return typeof c === 'string' ? c : undefined;
}

/**
 * Decide what the engine does with an error thrown by a step:
 *  retry (transient), fatal (fail the run), auth (fail + flag connection),
 *  stop (Filter → FILTERED), suspend (Delay).
 * Unknown errors are fatal: retrying a TypeError in connector code won't help.
 */
export function classifyError(err: unknown): ErrorClass {
  if (err instanceof StopRun) return { kind: 'stop', reason: err.reason };
  if (err instanceof SuspendRun) return { kind: 'suspend', resumeAt: err.resumeAt };
  if (err instanceof AuthError) return { kind: 'auth', error: { message: err.message, code: err.code } };
  if (err instanceof RetryableError) return { kind: 'retry', error: { message: err.message, code: err.code }, retryAfterMs: err.retryAfterMs };
  if (err instanceof FatalError || err instanceof ConnectorError) return { kind: 'fatal', error: { message: err.message, code: err.code } };
  if (err instanceof ConnectionNotFoundError) return { kind: 'fatal', error: { message: 'The account for this step was deleted', code: 'CONNECTION_NOT_FOUND' } };
  if (err instanceof DecryptionError) return { kind: 'fatal', error: { message: 'Stored credentials could not be decrypted — reconnect the account', code: 'DECRYPTION_FAILED' } };
  if (err instanceof TemplateSyntaxError || err instanceof UnknownFilterError) return { kind: 'fatal', error: { message: err.message, code: 'TEMPLATE_ERROR' } };
  const code = codeOf(err);
  if (code && NETWORK_CODES.has(code)) return { kind: 'retry', error: { message: (err as Error).message, code } };
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'fatal', error: { message: message || 'Unknown error', code: code ?? 'STEP_ERROR' } };
}
