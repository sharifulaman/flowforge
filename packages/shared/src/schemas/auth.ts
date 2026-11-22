import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address' }))
  .refine((v) => v.length <= 254, 'Email is too long');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1, 'Name is required').max(100),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    hasPassword: boolean;
    createdAt: string;
  };
  workspaces: Array<{ id: string; name: string; slug: string; role: WorkspaceRole }>;
}
