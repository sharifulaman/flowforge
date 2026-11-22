import { z } from 'zod';
import { emailSchema } from './auth';

export const roleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = createWorkspaceSchema.partial();
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

export const addMemberSchema = z.object({
  email: emailSchema,
  role: roleSchema.default('MEMBER'),
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberSchema = z.object({ role: roleSchema });
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  /** Days until expiry; omit for a non-expiring key. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: z.infer<typeof roleSchema>;
  joinedAt: string;
}

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}
