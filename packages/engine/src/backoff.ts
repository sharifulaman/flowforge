import { RUN_BACKOFF_BASE_MS } from '@flowforge/shared';

export const MAX_BACKOFF_MS = 15 * 60_000;
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

/**
 * Delay before retry number `attemptsMade` (1 = first retry).
 * Exponential (base · 2^(n-1)) with ±20% jitter, capped at 15 min. A provider-supplied
 * Retry-After wins (capped at 1 h).
 */
export function computeBackoff(attemptsMade: number, retryAfterMs?: number, base = RUN_BACKOFF_BASE_MS, random = Math.random): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  const exp = base * 2 ** Math.max(0, attemptsMade - 1);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(exp * jitter, MAX_BACKOFF_MS));
}
