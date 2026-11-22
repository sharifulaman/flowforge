import type { Role } from '@flowforge/db';

/** Who is making the request. Set by AuthGuard. */
export type Principal =
  | { type: 'user'; userId: string; sessionId: string }
  | { type: 'apiKey'; apiKeyId: string; workspaceId: string; actingUserId: string };

/** The workspace a request is scoped to. Set by WorkspaceGuard. */
export interface WorkspaceContext {
  id: string;
  role: Role;
}
