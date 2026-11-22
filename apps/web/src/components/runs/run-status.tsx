import type { RunSource, RunStatus, StepRunStatus } from '@flowforge/shared';
import {
  BanIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  ClockIcon,
  FilterIcon,
  HandIcon,
  Loader2Icon,
  RefreshCwIcon,
  RssIcon,
  WebhookIcon,
  XCircleIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type AnyStatus = RunStatus | StepRunStatus;

const STATUS: Record<AnyStatus, { label: string; icon: LucideIcon; tone: string; spin?: boolean }> = {
  QUEUED: { label: 'Queued', icon: ClockIcon, tone: 'text-muted-foreground bg-muted' },
  PENDING: { label: 'Pending', icon: ClockIcon, tone: 'text-muted-foreground bg-muted' },
  RUNNING: { label: 'Running', icon: Loader2Icon, tone: 'text-primary bg-primary/10', spin: true },
  WAITING: { label: 'Waiting', icon: CircleDashedIcon, tone: 'text-warning bg-warning/15' },
  SUCCEEDED: { label: 'Succeeded', icon: CheckCircle2Icon, tone: 'text-success bg-success/15' },
  FAILED: { label: 'Failed', icon: XCircleIcon, tone: 'text-destructive bg-destructive/15' },
  FILTERED: { label: 'Filtered', icon: FilterIcon, tone: 'text-muted-foreground bg-muted' },
  CANCELED: { label: 'Canceled', icon: BanIcon, tone: 'text-muted-foreground bg-muted' },
  SKIPPED: { label: 'Skipped', icon: BanIcon, tone: 'text-muted-foreground bg-muted' },
};

/** Status is always icon + label (never color alone). */
export function RunStatusBadge({ status, className }: { status: AnyStatus; className?: string }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap', s.tone, className)} data-status={status}>
      <Icon className={cn('size-3.5', s.spin && 'animate-spin')} aria-hidden />
      {s.label}
    </span>
  );
}

export function RunStatusIcon({ status, className }: { status: AnyStatus; className?: string }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return <Icon className={cn('size-4', s.tone.split(' ')[0], s.spin && 'animate-spin', className)} aria-label={s.label} />;
}

const SOURCE: Record<RunSource, { label: string; icon: LucideIcon }> = {
  WEBHOOK: { label: 'Webhook', icon: WebhookIcon },
  SCHEDULE: { label: 'Schedule', icon: CalendarClockIcon },
  POLL: { label: 'Polling', icon: RssIcon },
  APP_EVENT: { label: 'App event', icon: ZapIcon },
  MANUAL: { label: 'Manual', icon: HandIcon },
  REPLAY: { label: 'Replay', icon: RefreshCwIcon },
};

export function RunSourceLabel({ source }: { source: RunSource }) {
  const s = SOURCE[source];
  const Icon = s.icon;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Icon className="size-3.5" aria-hidden /> {s.label}
    </span>
  );
}

export const RUN_SOURCES = Object.keys(SOURCE) as RunSource[];
export const sourceLabel = (s: RunSource) => SOURCE[s].label;
