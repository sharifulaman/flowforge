'use client';

import type { AppManifest } from '@flowforge/connector-sdk';
import type { RunDetailDto, RunPlanStep, StepRunDto } from '@flowforge/shared';
import { ArrowLeftIcon, BanIcon, ChevronDownIcon, CircleDashedIcon, ExternalLinkIcon, RefreshCwIcon, SearchXIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { AppIcon } from '@/components/apps/app-icon';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { JsonView } from '@/components/common/json-view';
import { RunSourceLabel, RunStatusBadge } from '@/components/runs/run-status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useApps } from '@/hooks/use-builder';
import { isTerminal, useRun, useRunActions } from '@/hooks/use-runs';
import { ApiError } from '@/lib/api-client';
import { formatDuration, relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

export default function RunDetailPage() {
  const { workspaceId: ws, runId } = useParams<{ workspaceId: string; runId: string }>();
  const run = useRun(ws, runId);
  const apps = useApps();
  const actions = useRunActions(ws);
  const router = useRouter();
  const [replayOpen, setReplayOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  if (run.isLoading) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-24" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }
  if (!run.data) {
    return <EmptyState icon={SearchXIcon} title="Run not found" action={<Button asChild variant="outline"><Link href={`/w/${ws}/runs`}>Back to runs</Link></Button>} />;
  }

  const r = run.data;
  const byKey = new Map(r.steps.map((s) => [s.stepKey, s]));
  const appOf = (k: string) => apps.data?.byKey.get(k);

  return (
    <div className="grid grid-cols-1 gap-6" data-testid="run-detail">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1.5">
          <Link href={`/w/${ws}/runs`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-3.5" /> Runs
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{r.zapName}</h1>
            <RunStatusBadge status={r.status} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <RunSourceLabel source={r.source} />
            <span title={new Date(r.queuedAt).toLocaleString()}>Started {relativeTime(r.startedAt ?? r.queuedAt)}</span>
            <span>Duration {formatDuration(r.durationMs)}</span>
            <span>
              Attempt{r.attempts === 1 ? '' : 's'} {r.attempts}
            </span>
            <Link href={`/w/${ws}/zaps/${r.zapId}`} className="inline-flex items-center gap-1 hover:text-foreground">
              Version {r.zapVersion} <ExternalLinkIcon className="size-3" />
            </Link>
            {r.replayOfId && (
              <Link href={`/w/${ws}/runs/${r.replayOfId}`} className="hover:text-foreground">
                Replay of {r.replayOfId.slice(-8)}
              </Link>
            )}
            <code className="font-mono">{r.id}</code>
          </div>
        </div>
        <div className="flex gap-2">
          {!isTerminal(r.status) && (
            <Button variant="outline" onClick={() => setCancelOpen(true)}>
              <BanIcon /> Cancel
            </Button>
          )}
          {isTerminal(r.status) && (
            <Button onClick={() => setReplayOpen(true)} data-testid="replay">
              <RefreshCwIcon /> Replay
            </Button>
          )}
        </div>
      </div>

      {r.error && r.status === 'FAILED' && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <p className="font-medium text-destructive">
            {r.error.stepKey ? `Step ${r.error.stepKey} failed` : 'Run failed'}
            {r.error.code && <code className="ml-2 text-xs font-normal opacity-80">{r.error.code}</code>}
          </p>
          <p className="mt-1 text-destructive/90">{r.error.message}</p>
        </div>
      )}
      {r.status === 'WAITING' && r.error && (
        <p className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">Retrying after a temporary error: {r.error.message}</p>
      )}

      <ol className="relative grid grid-cols-1 gap-3">
        <TimelineItem
          index={0}
          plan={r.plan.trigger}
          app={appOf(r.plan.trigger.appKey)}
          status="SUCCEEDED"
          defaultOpen={false}
          body={
            <section className="grid gap-1.5">
              <h4 className="text-xs font-medium text-muted-foreground">Trigger data</h4>
              <JsonView value={r.triggerOutput} />
            </section>
          }
        />
        {r.plan.steps.map((p, i) => {
          const s = byKey.get(p.key);
          return (
            <TimelineItem
              key={p.key}
              index={i + 1}
              plan={p}
              app={appOf(p.appKey)}
              status={s?.status ?? null}
              step={s}
              defaultOpen={s?.status === 'FAILED'}
              body={s ? <StepBody step={s} /> : <p className="text-sm text-muted-foreground">This step did not run.</p>}
            />
          );
        })}
      </ol>

      <ReplayDialog
        open={replayOpen}
        onOpenChange={setReplayOpen}
        run={r}
        busy={actions.replay.isPending}
        onReplay={async (mode) => {
          try {
            const res = await actions.replay.mutateAsync({ runId: r.id, mode });
            toast.success('Replay started');
            setReplayOpen(false);
            router.push(`/w/${ws}/runs/${res.runId}`);
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : 'Could not replay');
          }
        }}
      />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel this run?"
        description="Steps already completed are not undone. Remaining steps won’t run."
        confirmLabel="Cancel run"
        onConfirm={() => actions.cancel.mutateAsync(r.id).then(() => run.refetch())}
      />
    </div>
  );
}

function TimelineItem({
  index,
  plan,
  app,
  status,
  step,
  body,
  defaultOpen,
}: {
  index: number;
  plan: RunPlanStep;
  app: AppManifest | undefined;
  status: StepRunDto['status'] | null;
  step?: StepRunDto;
  body: React.ReactNode;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const op = app ? (index === 0 ? app.triggers : app.actions).find((o) => o.key === plan.operationKey) : undefined;
  return (
    <li className={cn('min-w-0 rounded-xl border bg-card shadow-sm transition-shadow', open && 'shadow-md', !status && 'opacity-70')} data-testid={`timeline-${plan.key}`}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 p-3 text-left" aria-expanded={open}>
        <span className="w-6 text-center text-xs text-muted-foreground tabular-nums">{index + 1}</span>
        <AppIcon app={app} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{plan.name ?? op?.name ?? plan.operationKey}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {app?.name ?? plan.appKey} · <code>{plan.key}</code>
            {step && step.attempts > 1 && ` · ${step.attempts} attempts`}
          </span>
        </span>
        {step && <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">{formatDuration(step.durationMs)}</span>}
        {status ? (
          <RunStatusBadge status={status} />
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <CircleDashedIcon className="size-3.5" /> Not run
          </span>
        )}
        <ChevronDownIcon className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="grid min-w-0 grid-cols-1 gap-3 border-t p-4 animate-in fade-in-0">{body}</div>}
    </li>
  );
}

function StepBody({ step }: { step: StepRunDto }) {
  const logs = Array.isArray(step.logs) ? (step.logs as Array<{ level: string; message: string; at?: string }>) : [];
  return (
    <>
      {step.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {step.error.message}
          {step.error.code && <code className="ml-2 text-xs opacity-80">{step.error.code}</code>}
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="grid min-w-0 content-start gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">Data in</h4>
          <JsonView value={step.input} maxHeight="max-h-72" />
        </section>
        <section className="grid min-w-0 content-start gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">Data out</h4>
          {step.output !== null ? <JsonView value={step.output} maxHeight="max-h-72" /> : <p className="text-sm text-muted-foreground">No output.</p>}
        </section>
      </div>
      {logs.length > 0 && (
        <section className="grid gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">Logs</h4>
          <div className="max-h-48 overflow-auto rounded-lg border bg-muted/40 p-2 font-mono text-xs">
            {logs.map((l, i) => (
              <div key={i} className={l.level === 'error' ? 'text-destructive' : l.level === 'warn' ? 'text-warning' : undefined}>
                <span className="opacity-60">[{l.level}]</span> {l.message}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function ReplayDialog({
  open,
  onOpenChange,
  run,
  busy,
  onReplay,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  run: RunDetailDto;
  busy: boolean;
  onReplay: (mode: 'from_failed' | 'full') => void;
}) {
  const canResume = run.status === 'FAILED';
  const done = run.steps.filter((s) => s.status === 'SUCCEEDED').length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Replay run</DialogTitle>
          <DialogDescription>Replays use the same Zap version ({`v${run.zapVersion}`}) and the original trigger data.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {canResume && (
            <button type="button" disabled={busy} onClick={() => onReplay('from_failed')} className="rounded-lg border p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/50" data-testid="replay-from-failed">
              <p className="text-sm font-medium">Retry from the failed step</p>
              <p className="text-xs text-muted-foreground">Reuses the {done} step{done === 1 ? '' : 's'} that already succeeded; doesn’t repeat their side effects.</p>
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => onReplay('full')} className="rounded-lg border p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/50" data-testid="replay-full">
            <p className="text-sm font-medium">Run every step again</p>
            <p className="text-xs text-muted-foreground">All actions run again — emails, messages and rows may be sent twice.</p>
          </button>
        </div>
        <DialogFooter>
          {busy && <Spinner />}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
