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

/**
 * Retry policy for run jobs. The worker resumes at the failed step (completed steps are
 * checkpointed), so retries are safe. Backoff: 10s, 20s, 40s, 80s (+ jitter in the worker).
 */
export const RUN_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};
