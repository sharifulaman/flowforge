import { z } from 'zod';

export const runStatusSchema = z.enum(['QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'FILTERED', 'CANCELED']);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const runSourceSchema = z.enum(['WEBHOOK', 'SCHEDULE', 'POLL', 'APP_EVENT', 'MANUAL', 'REPLAY']);
export type RunSource = z.infer<typeof runSourceSchema>;
export type StepRunStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'FILTERED';

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['SUCCEEDED', 'FAILED', 'FILTERED', 'CANCELED'];

export const listRunsQuerySchema = z.object({
  zapId: z.string().max(40).optional(),
  status: runStatusSchema.optional(),
  source: runSourceSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const replayRunSchema = z.object({
  mode: z.enum(['from_failed', 'full']).default('from_failed'),
});
export type ReplayRunInput = z.infer<typeof replayRunSchema>;

export interface RunError {
  message: string;
  code?: string;
  stepKey?: string;
}

export interface RunSummaryDto {
  id: string;
  zapId: string;
  zapName: string;
  status: RunStatus;
  source: RunSource;
  error: RunError | null;
  attempts: number;
  replayOfId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface StepRunDto {
  id: string;
  stepKey: string;
  position: number;
  appKey: string;
  operationKey: string;
  status: StepRunStatus;
  input: unknown;
  output: unknown;
  error: RunError | null;
  attempts: number;
  logs: unknown;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface RunDetailDto extends RunSummaryDto {
  zapVersion: number;
  triggerOutput: unknown;
  steps: StepRunDto[];
}
