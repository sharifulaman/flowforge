'use client';

import type { Paginated, ReplayRunInput, RunDetailDto, RunSource, RunStatus, RunSummaryDto, StatsDto, StatsRange } from '@flowforge/shared';
import { TERMINAL_RUN_STATUSES } from '@flowforge/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export interface RunFilters {
  status?: RunStatus;
  source?: RunSource;
  zapId?: string;
}

export const isTerminal = (s: RunStatus) => TERMINAL_RUN_STATUSES.includes(s);

export function useRunList(ws: string, filters: RunFilters, live: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.runList(ws, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '25' });
      for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
      if (pageParam) qs.set('cursor', pageParam);
      return api<Paginated<RunSummaryDto>>(`/workspaces/${ws}/runs?${qs}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Live mode refreshes the first page(s) every few seconds.
    refetchInterval: live ? 5_000 : false,
  });
}

export function useRun(ws: string, runId: string) {
  return useQuery({
    queryKey: queryKeys.run(ws, runId),
    queryFn: () => api<RunDetailDto>(`/workspaces/${ws}/runs/${runId}`),
    // Poll while the run is in progress.
    refetchInterval: (q) => (q.state.data && !isTerminal(q.state.data.status) ? 1_500 : false),
  });
}

export function useRunActions(ws: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.runs(ws) });
  return {
    replay: useMutation({
      mutationFn: ({ runId, ...body }: ReplayRunInput & { runId: string }) => api<{ runId: string }>(`/workspaces/${ws}/runs/${runId}/replay`, { method: 'POST', body }),
      onSuccess: refresh,
    }),
    cancel: useMutation({ mutationFn: (runId: string) => api<RunSummaryDto>(`/workspaces/${ws}/runs/${runId}/cancel`, { method: 'POST' }), onSuccess: refresh }),
  };
}

export function useStats(ws: string, range: StatsRange) {
  return useQuery({
    queryKey: queryKeys.stats(ws, range),
    queryFn: () => api<StatsDto>(`/workspaces/${ws}/stats?range=${range}`),
    refetchInterval: 30_000,
  });
}
