import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from 'lucide-react';
import type { Delta } from '@/lib/chart';
import { cn } from '@/lib/utils';

/** label · value · optional delta vs the previous period (icon + text, never color alone). */
export function StatTile({ label, value, delta, deltaLabel, hint }: { label: string; value: string; delta?: Delta | null; deltaLabel?: string; hint?: string }) {
  const Icon = delta?.direction === 'up' ? ArrowUpRightIcon : delta?.direction === 'down' ? ArrowDownRightIcon : MinusIcon;
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm" data-testid="stat-tile">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight">{value}</p>
      <div className="mt-1 h-5 text-xs">
        {delta && deltaLabel ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-medium',
              delta.good === true && 'text-success',
              delta.good === false && 'text-destructive',
              delta.good === null && 'text-muted-foreground',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {deltaLabel}
            <span className="ml-1 font-normal text-muted-foreground">vs previous period</span>
          </span>
        ) : (
          hint && <span className="text-muted-foreground">{hint}</span>
        )}
      </div>
    </div>
  );
}
