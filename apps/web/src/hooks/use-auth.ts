'use client';

import type { LoginInput, MeResponse, RegisterInput } from '@flowforge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api<MeResponse>('/auth/me'),
    staleTime: 60_000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => api<MeResponse>('/auth/login', { method: 'POST', body: input }),
    onSuccess: (me) => qc.setQueryData(queryKeys.me, me),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterInput) => api<MeResponse>('/auth/register', { method: 'POST', body: input }),
    onSuccess: (me) => qc.setQueryData(queryKeys.me, me),
  });
}

export function useLogout() {
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    // Hard navigation: drops every in-memory cache and mounted query in one go, so no
    // authenticated query can refetch (and 401) between clearing state and leaving the page.
    onSettled: () => window.location.replace('/login'),
  });
}
