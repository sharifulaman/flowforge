'use client';

import { ChevronRightIcon, SearchIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AppIcon } from '@/components/apps/app-icon';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { flattenSample, formatReference } from '@/lib/template-utils';
import { cn } from '@/lib/utils';
import type { TemplateContextValue } from './template-context';

const TYPE_TINT: Record<string, string> = {
  string: 'text-emerald-600 dark:text-emerald-400',
  number: 'text-amber-600 dark:text-amber-400',
  boolean: 'text-violet-600 dark:text-violet-400',
  object: 'text-sky-600 dark:text-sky-400',
  array: 'text-sky-600 dark:text-sky-400',
  null: 'text-muted-foreground',
};

/** Browse earlier steps' sample data and pick a field to insert as {{ step.path }}. */
export function FieldPicker({ ctx, onPick }: { ctx: TemplateContextValue; onPick: (reference: string) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(ctx.previous.map((s) => [s.key, true])));

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ctx.previous.map((step, i) => {
      const fields = flattenSample(step.sample).filter(
        (f) => !needle || f.label.toLowerCase().includes(needle) || f.preview.toLowerCase().includes(needle),
      );
      return { step, index: i, fields };
    });
  }, [ctx.previous, q]);

  if (!ctx.previous.length) {
    return <p className="p-2 text-sm text-muted-foreground">Data from earlier steps will appear here once you add a trigger.</p>;
  }

  return (
    <div className="grid gap-2" data-testid="field-picker">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields…" className="h-8 pl-8 text-xs" />
      </div>
      <div className="max-h-80 overflow-y-auto pr-1">
        {groups.map(({ step, index, fields }) => {
          const app = ctx.apps.get(step.appKey);
          const isOpen = open[step.key] ?? true;
          return (
            <div key={step.key} className="mb-1">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [step.key]: !isOpen }))}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs font-medium hover:bg-accent"
              >
                <ChevronRightIcon className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')} />
                <AppIcon app={app} size="sm" />
                <span className="truncate">
                  {index + 1}. {step.name ?? app?.name ?? step.appKey}
                </span>
                <code className="ml-auto text-[10px] text-muted-foreground">{step.key}</code>
                {step.isExample && (
                  <Badge variant="warning" className="px-1 text-[10px]">
                    example
                  </Badge>
                )}
              </button>
              {isOpen && (
                <div className="ml-3 border-l pl-1">
                  {fields.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">{q ? 'No matches' : 'No data yet — test this step to load fields.'}</p>}
                  {fields.map((f) => (
                    <button
                      key={f.path.join('\u0000')}
                      type="button"
                      onClick={() => onPick(formatReference(step.key, f.path))}
                      className="group flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-primary/10"
                      style={{ paddingLeft: `${0.5 + f.depth * 0.75}rem` }}
                      title={formatReference(step.key, f.path)}
                    >
                      <span className="shrink-0 font-medium">{String(f.path[f.path.length - 1])}</span>
                      <span className={cn('shrink-0 text-[10px]', TYPE_TINT[f.type])}>{f.type}</span>
                      <span className="truncate text-muted-foreground group-hover:text-foreground">{f.preview}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
