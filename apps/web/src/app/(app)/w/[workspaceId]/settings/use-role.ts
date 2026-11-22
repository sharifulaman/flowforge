'use client';

import type { WorkspaceRole } from '@flowforge/shared';
import { useMe } from '@/hooks/use-auth';

const RANK: Record<WorkspaceRole, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

export function useWorkspaceRole(ws: string) {
  const { data } = useMe();
  const w = data?.workspaces.find((x) => x.id === ws);
  const role = w?.role;
  return { workspace: w, role, userId: data?.user.id, atLeast: (r: WorkspaceRole) => !!role && RANK[role] >= RANK[r] };
}
