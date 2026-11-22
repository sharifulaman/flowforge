'use client';

import type { StatsRange } from '@flowforge/shared';
import { ActivityIcon, AlertTriangleIcon, ArrowRightIcon, PlugIcon, WorkflowIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { RunsChart } from '@/components/dashboard/runs-chart';
import { StatTile } from '@/components/dashboard/stat-tile';
import { PageHeader } from '@/components/layout/page-header';
import { RunStatusBadge } from '@/components/runs/run-status';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMe } from '@/hooks/use-auth';
import { useRunList, useStats } from '@/hooks/use-runs';
import { compactNumber, delta } from '@/lib/chart';
import { formatDuration, relativeTime } from '@/lib/time';

const STEPS = [
  { icon: PlugIcon, href: '/connections', title: 'Connect an app', description: 'Securely add credentials for Slack, Google Sheets, Telegram, SMTP and more.' },
  { icon: WorkflowIcon, href: '/zaps', title: 'Build your first Zap', description: 'Pick a trigger, add actions, and map data between steps visually.' },
  { icon: ActivityIcon, href: '/runs', title: 'Watch it run', description: 'Inspect every run step-by-step, and replay failures with one click.' },
];

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(v === 1 ? 0 : 1)}%`);

export default function DashboardPage() {
  const { data: me } = useMe();
  const { workspaceId: ws } = useParams<{ workspaceId: string }>();
  const [range, setRange] = useState<StatsRange>('7d');
  const stats = useStats(ws, range);
  const recent = useRunList(ws, {}, true);
  const firstName = me?.user.name?.split(' ')[0];
  const s = stats.data;

  if (s && s.zaps.total === 0) {
    return (
      <>
        <PageHeader title={firstName ? `Welcome, ${firstName}` : 'Welcome'} description="Here's how to get your first automation running." />
        <div className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((st, i) => (
            <Link key={st.title} href={`/w/${ws}${st.href}`} className="rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none">
              <Card className="group h-full gap-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
                <CardHeader className="gap-3">
                  <div className="flex items-center justify-between">
                    <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <st.icon className="size-4" />
                    </span>
                    <Badge variant="secondary">Step {i + 1}</Badge>
                  </div>
                  <CardTitle className="flex items-center gap-1.5">
                    {st.title}
                    <ArrowRightIcon className="size-3.5 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-60" />
                  </CardTitle>
                  <CardDescription>{st.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </>
    );
  }

  const rateDelta = s ? delta(s.totals.successRate, s.previous.successRate, true) : null;
  const runsDelta = s ? delta(s.totals.total, s.previous.total, true) : null;
  const failDelta = s ? delta(s.totals.failed, s.previous.failed, false) : null;

  return (
    <>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : 'Dashboard'}
        description="How your automations are doing."
        actions={
          <Tabs value={range} onValueChange={(v) => setRange(v as StatsRange)}>
            <TabsList>
              <TabsTrigger value="24h">24 hours</TabsTrigger>
              <TabsTrigger value="7d">7 days</TabsTrigger>
              <TabsTrigger value="30d">30 days</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {!s ? (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[108px] rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Runs" value={compactNumber(s.totals.total)} delta={runsDelta} deltaLabel={runsDelta ? `${runsDelta.value > 0 ? '+' : ''}${compactNumber(runsDelta.value)}` : undefined} hint={s.totals.inProgress ? `${s.totals.inProgress} in progress` : undefined} />
            <StatTile
              label="Success rate"
              value={pct(s.totals.successRate)}
              delta={rateDelta}
              deltaLabel={rateDelta ? `${rateDelta.value > 0 ? '+' : ''}${(rateDelta.value * 100).toFixed(1)} pts` : undefined}
              hint="Succeeded ÷ (succeeded + failed)"
            />
            <StatTile label="Failed runs" value={compactNumber(s.totals.failed)} delta={failDelta} deltaLabel={failDelta ? `${failDelta.value > 0 ? '+' : ''}${failDelta.value}` : undefined} />
            <StatTile label="Duration (p95)" value={formatDuration(s.totals.p95DurationMs)} hint={s.totals.p50DurationMs !== null ? `Median ${formatDuration(s.totals.p50DurationMs)}` : 'No completed runs yet'} />
          </div>

          <Card className="gap-4">
            <CardHeader>
              <CardTitle>Runs over time</CardTitle>
              <CardDescription>{range === '24h' ? 'Per hour' : 'Per day'}, UTC</CardDescription>
            </CardHeader>
            <CardContent>
              {s.totals.total === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">No runs in this period yet.</p>
              ) : (
                <RunsChart series={s.series} bucket={s.bucket} />
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="gap-3 lg:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Recent runs</CardTitle>
                <Link href={`/w/${ws}/runs`} className="text-xs text-muted-foreground hover:text-foreground">
                  View all
                </Link>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {(recent.data?.pages[0]?.items ?? []).slice(0, 6).map((r) => (
                    <li key={r.id}>
                      <Link href={`/w/${ws}/runs/${r.id}`} className="flex items-center gap-3 py-2 text-sm hover:text-primary">
                        <RunStatusBadge status={r.status} />
                        <span className="min-w-0 flex-1 truncate">{r.zapName}</span>
                        <span className="text-xs text-muted-foreground">{relativeTime(r.queuedAt)}</span>
                      </Link>
                    </li>
                  ))}
                  {recent.data && !recent.data.pages[0]?.items.length && <li className="py-6 text-center text-sm text-muted-foreground">No runs yet.</li>}
                </ul>
              </CardContent>
            </Card>

            <div className="grid content-start gap-4">
              <Card className="gap-3">
                <CardHeader>
                  <CardTitle>Needs attention</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm">
                  {s.topFailing.length === 0 && s.zaps.error === 0 && s.connectionsNeedingAttention === 0 && <p className="text-muted-foreground">All clear. Nothing is failing.</p>}
                  {s.topFailing.map((z) => (
                    <Link key={z.zapId} href={`/w/${ws}/runs?zapId=${z.zapId}&status=FAILED`} className="grid gap-0.5 rounded-lg border p-2.5 hover:bg-accent/40" data-testid="top-failing">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{z.name}</span>
                        <span className="flex shrink-0 items-center gap-1 text-xs text-destructive">
                          <AlertTriangleIcon className="size-3.5" /> {z.failed} failed
                        </span>
                      </span>
                      {z.lastError && <span className="truncate text-xs text-muted-foreground">{z.lastError}</span>}
                    </Link>
                  ))}
                  {s.zaps.error > 0 && (
                    <Link href={`/w/${ws}/zaps`} className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-destructive">
                      <AlertTriangleIcon className="size-4" /> {s.zaps.error} Zap{s.zaps.error === 1 ? ' was' : 's were'} switched off after repeated failures
                    </Link>
                  )}
                  {s.connectionsNeedingAttention > 0 && (
                    <Link href={`/w/${ws}/connections`} className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 p-2.5">
                      <PlugIcon className="size-4 text-warning" /> {s.connectionsNeedingAttention} connection{s.connectionsNeedingAttention === 1 ? '' : 's'} need reconnecting
                    </Link>
                  )}
                </CardContent>
              </Card>
              <Card className="gap-2">
                <CardContent className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Zaps on</span>
                  <Link href={`/w/${ws}/zaps`} className="font-medium hover:text-primary">
                    {s.zaps.active} of {s.zaps.total}
                  </Link>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
