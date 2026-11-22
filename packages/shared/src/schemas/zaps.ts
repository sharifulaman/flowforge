import { z } from 'zod';

export const zapStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ERROR']);
export type ZapStatus = z.infer<typeof zapStatusSchema>;

/** Step configs are JSON objects; size-capped to keep rows and job payloads small. */
const configSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 64 * 1024, 'Step configuration is too large (max 64 KB)');

const appKey = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'Invalid app key');
const opKey = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid operation key');
const stepName = z.string().trim().max(100);
const timeoutMs = z.number().int().min(1_000).max(300_000);

export const createZapSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(500).optional(),
});
export type CreateZapInput = z.infer<typeof createZapSchema>;

export const updateZapSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});
export type UpdateZapInput = z.infer<typeof updateZapSchema>;

export const listZapsQuerySchema = z.object({
  status: zapStatusSchema.optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListZapsQuery = z.infer<typeof listZapsQuerySchema>;

export const setTriggerSchema = z.object({
  appKey,
  operationKey: opKey,
  connectionId: z.string().max(40).nullable().optional(),
  config: configSchema.default({}),
  name: stepName.optional(),
});
export type SetTriggerInput = z.infer<typeof setTriggerSchema>;

export const addStepSchema = z.object({
  appKey,
  operationKey: opKey,
  connectionId: z.string().max(40).nullable().optional(),
  config: configSchema.default({}),
  name: stepName.optional(),
  timeoutMs: timeoutMs.optional(),
  /** Insert after this step key ("trigger" = first action). Omit to append. */
  afterKey: z.string().max(40).optional(),
});
export type AddStepInput = z.infer<typeof addStepSchema>;

export const updateStepSchema = z.object({
  appKey: appKey.optional(),
  operationKey: opKey.optional(),
  connectionId: z.string().max(40).nullable().optional(),
  config: configSchema.optional(),
  name: stepName.nullable().optional(),
  timeoutMs: timeoutMs.nullable().optional(),
});
export type UpdateStepInput = z.infer<typeof updateStepSchema>;

export const reorderStepsSchema = z.object({
  /** All action step ids in the desired order. */
  order: z.array(z.string().max(40)).min(1).max(100),
});
export type ReorderStepsInput = z.infer<typeof reorderStepsSchema>;

export const manualRunSchema = z.object({
  /** Trigger output to use for this run. Defaults to the trigger's sample data. */
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type ManualRunInput = z.infer<typeof manualRunSchema>;

// ─── Response DTOs ─────────────────────────────────────────

export interface StepDto {
  id: string;
  key: string;
  type: 'TRIGGER' | 'ACTION';
  position: number;
  name: string | null;
  appKey: string;
  operationKey: string;
  connectionId: string | null;
  config: Record<string, unknown>;
  timeoutMs: number | null;
  sampleOutput: unknown;
  sampleAt: string | null;
}

export interface ZapSummaryDto {
  id: string;
  name: string;
  description: string | null;
  status: ZapStatus;
  /** App keys of the trigger + actions, in order (for icons in lists). */
  apps: string[];
  publishedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ZapDetailDto extends ZapSummaryDto {
  steps: StepDto[];
  trigger: {
    kind: string | null;
    /** Public URL for webhook / app-event triggers. */
    hookUrl: string | null;
    lastFiredAt: string | null;
    lastError: string | null;
  };
  /** True when the draft differs from the published version. */
  hasUnpublishedChanges: boolean;
  /** Non-blocking problems, e.g. references broken by reordering. */
  warnings: ReferenceWarning[];
}

export interface ZapVersionDto {
  id: string;
  version: number;
  createdAt: string;
  createdById: string;
  isPublished: boolean;
}

export interface PublishIssue {
  stepKey: string | null;
  field?: string;
  message: string;
}

export interface ReferenceWarning {
  stepKey: string;
  location: string;
  message: string;
}
