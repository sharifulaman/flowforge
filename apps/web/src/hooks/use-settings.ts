'use client';

import type { AddMemberInput, ApiKeyDto, CreateApiKeyInput, MemberDto, WorkspaceRole } from '@flowforge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  createdAt: string;
}

export function useWorkspaceActions() {
  const qc = useQueryClient();
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: queryKeys.me }), qc.invalidateQueries({ queryKey: queryKeys.workspaces })]);
  return {
    create: useMutation({ mutationFn: (name: string) => api<WorkspaceSummary>('/workspaces', { method: 'POST', body: { name } }), onSuccess: refresh }),
    rename: useMutation({
      mutationFn: ({ id, name }: { id: string; name: string }) => api<WorkspaceSummary>(`/workspaces/${id}`, { method: 'PATCH', body: { name } }),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: (id: string) => api<void>(`/workspaces/${id}`, { method: 'DELETE' }), onSuccess: refresh }),
  };
}

export function useMembers(ws: string) {
  return useQuery({ queryKey: queryKeys.members(ws), queryFn: () => api<MemberDto[]>(`/workspaces/${ws}/members`) });
}

export function useMemberActions(ws: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.members(ws) });
  return {
    add: useMutation({ mutationFn: (body: AddMemberInput) => api<MemberDto>(`/workspaces/${ws}/members`, { method: 'POST', body }), onSuccess: refresh }),
    setRole: useMutation({
      mutationFn: ({ id, role }: { id: string; role: WorkspaceRole }) => api<MemberDto>(`/workspaces/${ws}/members/${id}`, { method: 'PATCH', body: { role } }),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: (id: string) => api<void>(`/workspaces/${ws}/members/${id}`, { method: 'DELETE' }), onSuccess: refresh }),
  };
}

export function useApiKeys(ws: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.apiKeys(ws), queryFn: () => api<ApiKeyDto[]>(`/workspaces/${ws}/api-keys`), enabled });
}

export function useApiKeyActions(ws: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.apiKeys(ws) });
  return {
    create: useMutation({ mutationFn: (body: CreateApiKeyInput) => api<ApiKeyDto & { key: string }>(`/workspaces/${ws}/api-keys`, { method: 'POST', body }), onSuccess: refresh }),
    revoke: useMutation({ mutationFn: (id: string) => api<void>(`/workspaces/${ws}/api-keys/${id}`, { method: 'DELETE' }), onSuccess: refresh }),
  };
}
