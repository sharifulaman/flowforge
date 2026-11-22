'use client';

import type { AppManifest, SelectOption } from '@flowforge/connector-sdk';
import type {
  AddStepInput,
  ConnectionDto,
  CreateConnectionInput,
  ListZapsQuery,
  Paginated,
  SetTriggerInput,
  TestStepResult,
  UpdateStepInput,
  ZapDetailDto,
  ZapStatus,
  ZapSummaryDto,
} from '@flowforge/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export interface StepSample {
  key: string;
  name: string | null;
  type: 'TRIGGER' | 'ACTION';
  position: number;
  appKey: string;
  operationKey: string;
  sample: unknown;
  isExample: boolean;
}

// ─── Apps ───────────────────────────────────────────────────

export function useApps() {
  return useQuery({
    queryKey: queryKeys.apps,
    queryFn: () => api<AppManifest[]>('/apps'),
    staleTime: 5 * 60_000,
    select: (apps) => ({ list: apps, byKey: new Map(apps.map((a) => [a.key, a])) }),
  });
}

// ─── Zaps ───────────────────────────────────────────────────

export function useZapList(ws: string, filters: { q?: string; status?: ZapStatus }) {
  return useInfiniteQuery({
    queryKey: queryKeys.zapList(ws, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '20' });
      if (filters.q) qs.set('q', filters.q);
      if (filters.status) qs.set('status', filters.status);
      if (pageParam) qs.set('cursor', pageParam);
      return api<Paginated<ZapSummaryDto>>(`/workspaces/${ws}/zaps?${qs}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useZap(ws: string, zapId: string) {
  return useQuery({ queryKey: queryKeys.zap(ws, zapId), queryFn: () => api<ZapDetailDto>(`/workspaces/${ws}/zaps/${zapId}`) });
}

export function useSamples(ws: string, zapId: string) {
  return useQuery({ queryKey: queryKeys.samples(ws, zapId), queryFn: () => api<StepSample[]>(`/workspaces/${ws}/zaps/${zapId}/samples`) });
}

/** All zap mutations return the fresh ZapDetailDto; write it straight into the cache. */
function useZapMutation<V>(ws: string, zapId: string, fn: (vars: V) => Promise<ZapDetailDto>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (zap) => {
      qc.setQueryData(queryKeys.zap(ws, zapId), zap);
      void qc.invalidateQueries({ queryKey: queryKeys.samples(ws, zapId) });
      void qc.invalidateQueries({ queryKey: [...queryKeys.zaps(ws), 'list'] });
    },
  });
}

export function useZapActions(ws: string, zapId: string) {
  const base = `/workspaces/${ws}/zaps/${zapId}`;
  return {
    rename: useZapMutation(ws, zapId, (body: { name?: string; description?: string | null }) => api<ZapDetailDto>(base, { method: 'PATCH', body })),
    setTrigger: useZapMutation(ws, zapId, (body: SetTriggerInput) => api<ZapDetailDto>(`${base}/trigger`, { method: 'PUT', body })),
    addStep: useZapMutation(ws, zapId, (body: AddStepInput) => api<ZapDetailDto>(`${base}/steps`, { method: 'POST', body })),
    updateStep: useZapMutation(ws, zapId, ({ stepId, ...body }: UpdateStepInput & { stepId: string }) =>
      api<ZapDetailDto>(`${base}/steps/${stepId}`, { method: 'PATCH', body }),
    ),
    deleteStep: useZapMutation(ws, zapId, (stepId: string) => api<ZapDetailDto>(`${base}/steps/${stepId}`, { method: 'DELETE' })),
    reorder: useZapMutation(ws, zapId, (order: string[]) => api<ZapDetailDto>(`${base}/steps/reorder`, { method: 'POST', body: { order } })),
    enable: useZapMutation(ws, zapId, () => api<ZapDetailDto>(`${base}/enable`, { method: 'POST' })),
    disable: useZapMutation(ws, zapId, () => api<ZapDetailDto>(`${base}/disable`, { method: 'POST' })),
    rotateToken: useZapMutation(ws, zapId, () => api<ZapDetailDto>(`${base}/trigger/rotate-token`, { method: 'POST' })),
  };
}

export function useTestStep(ws: string, zapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (stepId: string) => api<TestStepResult>(`/workspaces/${ws}/zaps/${zapId}/steps/${stepId}/test`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.samples(ws, zapId) });
      void qc.invalidateQueries({ queryKey: queryKeys.zap(ws, zapId) });
    },
  });
}

export function useCreateZap(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string }) => api<ZapDetailDto>(`/workspaces/${ws}/zaps`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.zaps(ws) }),
  });
}

export function useZapListActions(ws: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.zaps(ws) });
  return {
    toggle: useMutation({
      mutationFn: ({ id, on }: { id: string; on: boolean }) => api<ZapDetailDto>(`/workspaces/${ws}/zaps/${id}/${on ? 'enable' : 'disable'}`, { method: 'POST' }),
      onSettled: refresh,
    }),
    remove: useMutation({ mutationFn: (id: string) => api<void>(`/workspaces/${ws}/zaps/${id}`, { method: 'DELETE' }), onSettled: refresh }),
    duplicate: useMutation({ mutationFn: (id: string) => api<ZapDetailDto>(`/workspaces/${ws}/zaps/${id}/duplicate`, { method: 'POST' }), onSettled: refresh }),
  };
}

// ─── Connections ────────────────────────────────────────────

export function useConnections(ws: string) {
  return useQuery({ queryKey: queryKeys.connections(ws), queryFn: () => api<ConnectionDto[]>(`/workspaces/${ws}/connections`) });
}

export function useConnectionActions(ws: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.connections(ws) });
  return {
    create: useMutation({
      mutationFn: (body: CreateConnectionInput) => api<ConnectionDto>(`/workspaces/${ws}/connections`, { method: 'POST', body }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: string; name?: string; credentials?: Record<string, unknown> }) =>
        api<ConnectionDto>(`/workspaces/${ws}/connections/${id}`, { method: 'PATCH', body }),
      onSuccess: refresh,
    }),
    test: useMutation({ mutationFn: (id: string) => api<ConnectionDto>(`/workspaces/${ws}/connections/${id}/test`, { method: 'POST' }), onSettled: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api<void>(`/workspaces/${ws}/connections/${id}`, { method: 'DELETE' }), onSuccess: refresh }),
  };
}

/** Full-page navigation into the OAuth flow (the API redirects to the provider). */
export function oauthStartUrl(ws: string, appKey: string, opts: { connectionId?: string; name?: string; returnTo?: string } = {}) {
  const qs = new URLSearchParams();
  if (opts.connectionId) qs.set('connectionId', opts.connectionId);
  if (opts.name) qs.set('name', opts.name);
  if (opts.returnTo) qs.set('returnTo', opts.returnTo);
  return `/api/v1/workspaces/${ws}/connections/oauth/${appKey}/start${qs.size ? `?${qs}` : ''}`;
}

// ─── Dynamic options ────────────────────────────────────────

export function useDynamicOptions(
  ws: string,
  appKey: string,
  loader: string | undefined,
  connectionId: string | null,
  config: Record<string, unknown>,
  dependsOn: string[] = [],
  enabled = true,
) {
  const deps = JSON.stringify(dependsOn.map((k) => config[k] ?? null));
  return useQuery({
    queryKey: queryKeys.options(ws, appKey, loader ?? '', connectionId, deps),
    queryFn: () => api<SelectOption[]>(`/workspaces/${ws}/apps/${appKey}/options`, { method: 'POST', body: { loader, connectionId: connectionId ?? undefined, config } }),
    enabled: enabled && !!loader,
    staleTime: 60_000,
    retry: false,
  });
}
