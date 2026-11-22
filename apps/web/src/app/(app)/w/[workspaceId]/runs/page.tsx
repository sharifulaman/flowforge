'use client';

import type { RunSource, RunStatus } from '@flowforge/shared';
import { ActivityIcon, RadioIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { PageHeader } from '@/components/layout/page-header';
import { RUN_SOURCES, RunSourceLabel, RunStatusBadge, sourceLabel } from '@/components/runs/run-status';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useZapList } from '@/hooks/use-builder';
import { useRunList } from '@/hooks/use-runs';
import { formatDuration, relativeTime } from '@/lib/time';

const ALL = 'all';
const STATUS_TABS: Array<[string, string]> = [
  [ALL, 'All'],
  ['SUCCEEDED', 'Succeeded'],
  ['FAILED', 'Failed'],
  ['FILTERED', 'Filtered'],
  ['RUNNING', 'Running'],
  ['WAITING', 'Waiting'],
];

function RunsInner() {
  const { workspaceId: ws } = useParams<{ workspaceId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const status = (params.get('status') ?? undefined) as RunStatus | undefined;
  const source = (params.get('source') ?? undefined) as RunSource | undefined;
  const zapId = params.get('zapId') ?? undefined;
  const live = params.get('live') !== '0';

  const setParam = (key: string, value: string | undefined) => {
    const qs = new URLSearchParams(params.toString());
    if (value && value !== ALL) qs.set(key, value);
    else qs.delete(key);
    router.replace(`${pathname}${qs.size ? `?${qs}` : ''}`, { scroll: false });
  };

  const zaps = useZapList(ws, {});
  const list = useRunList(ws, { status, source, zapId }, live);
  const runs = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!(status || source || zapId);

  return (
    <>
      <PageHeader
        title="Runs"
        description="Every time a Zap runs, it’s recorded here with each step’s data."
        actions={
          <label className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm">
            <RadioIcon className={live ? 'size-4 text-success' : 'size-4 text-muted-foreground'} />
            Live
            <Switch checked={live} onCheckedChange={(c) => setParam('live', c ? undefined : '0')} aria-label="Auto-refresh" />
          </label>
        }
      />

      {/* Filters live in one row above the data. */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs value={status ?? ALL} onValueChange={(v) => setParam('status', v)}>
          <TabsList className="flex-wrap">
            {STATUS_TABS.map(([v, l]) => (
              <TabsTrigger key={v} value={v}>
                {l}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex gap-2">
          <Select value={zapId ?? ALL} onValueChange={(v) => setParam('zapId', v)}>
            <SelectTrigger className="w-48" aria-label="Filter by Zap">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Zaps</SelectItem>
              {zaps.data?.pages
                .flatMap((p) => p.items)
                .map((z) => (
                  <SelectItem key={z.id} value={z.id}>
                    {z.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Select value={source ?? ALL} onValueChange={(v) => setParam('source', v)}>
            <SelectTrigger className="w-36" aria-label="Filter by source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sources</SelectItem>
              {RUN_SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {sourceLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {list.isLoading ? (
        <div className="grid gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={ActivityIcon}
          title={filtered ? 'No runs match these filters' : 'No runs yet'}
          description={filtered ? 'Try clearing a filter.' : 'Turn on a Zap and its runs will show up here in real time.'}
          action={
            filtered ? (
              <Button variant="outline" onClick={() => router.replace(pathname)}>
                Clear filters
              </Button>
            ) : (
              <Button asChild>
                <Link href={`/w/${ws}/zaps`}>Go to Zaps</Link>
              </Button>
            )
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <table className="w-full text-sm" data-testid="runs-table">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Zap</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Source</th>
                <th className="px-4 py-2.5 font-medium">Started</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {runs.map((r) => (
                <tr key={r.id} className="group cursor-pointer transition-colors hover:bg-accent/40" onClick={() => router.push(`/w/${ws}/runs/${r.id}`)}>
                  <td className="px-4 py-3 align-top">
                    <RunStatusBadge status={r.status} />
                  </td>
                  <td className="max-w-0 px-4 py-3">
                    <Link href={`/w/${ws}/runs/${r.id}`} className="block truncate font-medium group-hover:text-primary" onClick={(e) => e.stopPropagation()}>
                      {r.zapName}
                    </Link>
                    {r.error && (
                      <p className="truncate text-xs text-muted-foreground" title={r.error.message}>
                        {r.error.stepKey && <code className="mr-1">{r.error.stepKey}</code>}
                        {r.error.message}
                      </p>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 align-top md:table-cell">
                    <RunSourceLabel source={r.source} />
                  </td>
                  <td className="px-4 py-3 align-top text-xs whitespace-nowrap text-muted-foreground" title={new Date(r.queuedAt).toLocaleString()}>
                    {relativeTime(r.queuedAt)}
                  </td>
                  <td className="hidden px-4 py-3 text-right align-top text-xs text-muted-foreground tabular-nums sm:table-cell">{formatDuration(r.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.hasNextPage && (
            <div className="border-t p-2 text-center">
              <Button variant="ghost" size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                {list.isFetchingNextPage && <Spinner />} Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function RunsPage() {
  return (
    <Suspense>
      <RunsInner />
    </Suspense>
  );
}
