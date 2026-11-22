/**
 * Queue contracts shared by the API (producer) and the worker (consumer).
 * Bump a queue name if a payload changes incompatibly.
 */
export const QUEUES = {
  /** One job per run; jobId === runId. */
  runs: 'ff-runs',
  /** Repeatable jobs for schedule + polling triggers; scheduler id === `zap:<zapId>`. */
  triggers: 'ff-triggers',
  /** Synchronous "test this step" requests from the builder. */
  testStep: 'ff-test-step',
  /** Periodic housekeeping (stuck-run reconciliation, dedupe cleanup). */
  maintenance: 'ff-maintenance',
} as const;

export interface RunJobData {
  runId: string;
  workspaceId: string;
}

export interface TriggerJobData {
  zapId: string;
  workspaceId: string;
  kind: 'schedule' | 'poll';
}

export const triggerSchedulerId = (zapId: string) => `zap:${zapId}`;

/** Custom backoff type implemented by the worker (exponential + jitter, honours Retry-After). */
export const RUN_BACKOFF_TYPE = 'ff-backoff';
export const RUN_BACKOFF_BASE_MS = 10_000;
export const RUN_MAX_ATTEMPTS = 5;

/**
 * Retry policy for run jobs. The worker resumes at the failed step (completed steps are
 * checkpointed), so retries are safe. Backoff ≈ 10s, 20s, 40s, 80s ±20% jitter.
 */
export const RUN_JOB_OPTIONS = {
  attempts: RUN_MAX_ATTEMPTS,
  backoff: { type: RUN_BACKOFF_TYPE, delay: RUN_BACKOFF_BASE_MS },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export interface TestStepJobData {
  workspaceId: string;
  zapId: string;
  stepId: string;
}

export interface TestStepResult {
  status: 'success' | 'error' | 'filtered';
  /** Resolved input the step ran with (actions only). */
  input: unknown;
  output: unknown;
  error: { message: string; code?: string } | null;
  logs: Array<{ level: string; message: string }>;
  durationMs: number;
}

export const TEST_STEP_TIMEOUT_MS = 60_000;
