import { z } from 'zod';

const nameSchema = z.string().trim().min(1, 'Name is required').max(100);

/** For API-key / basic / custom auth. `credentials` is validated against the app's auth schema. */
export const createConnectionSchema = z.object({
  appKey: z.string().min(1).max(64),
  name: nameSchema.optional(),
  credentials: z.record(z.string(), z.unknown()),
});
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

export const updateConnectionSchema = z.object({
  name: nameSchema.optional(),
  /** Replace credentials entirely (re-validated and re-tested). */
  credentials: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;

export interface ConnectionDto {
  id: string;
  appKey: string;
  name: string;
  authType: 'OAUTH2' | 'API_KEY' | 'BASIC' | 'CUSTOM';
  status: 'ACTIVE' | 'ERROR' | 'EXPIRED';
  displayInfo: Record<string, unknown> | null;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** Number of steps (in any zap) using this connection. */
  usedBySteps: number;
}

export const loadOptionsSchema = z.object({
  /** Key of the app's dynamic options loader (from `x-ui.dynamicOptions`). */
  loader: z.string().min(1).max(64),
  connectionId: z.string().optional(),
  /** Current (partial) step config, so loaders can depend on other fields. */
  config: z.record(z.string(), z.unknown()).default({}),
});
export type LoadOptionsInput = z.infer<typeof loadOptionsSchema>;
