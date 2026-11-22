'use client';

import type { AppManifest } from '@flowforge/connector-sdk';
import { ArrowLeftIcon, SearchIcon, ZapIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AppIcon } from '@/components/apps/app-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type PickerMode = 'trigger' | 'action';

const KIND_LABEL: Record<string, string> = { webhook: 'Instant', app_webhook: 'Instant', polling: 'Polling', schedule: 'Scheduled' };

/** Two-step picker: choose an app, then one of its triggers/actions. */
export function AppPickerDialog({
  open,
  onOpenChange,
  mode,
  apps,
  onPick,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: PickerMode;
  apps: AppManifest[];
  onPick: (appKey: string, operationKey: string) => void;
  busy?: boolean;
}) {
  const [q, setQ] = useState('');
  const [app, setApp] = useState<AppManifest | null>(null);
  useEffect(() => {
    if (open) {
      setQ('');
      setApp(null);
    }
  }, [open]);

  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return apps
      .filter((a) => (mode === 'trigger' ? a.triggers.length : a.actions.length) > 0)
      .filter((a) => !needle || a.name.toLowerCase().includes(needle) || a.description.toLowerCase().includes(needle));
  }, [apps, mode, q]);
  const builtIn = candidates.filter((a) => a.category === 'core');
  const integrations = candidates.filter((a) => a.category !== 'core');

  const ops = app ? (mode === 'trigger' ? app.triggers : app.actions) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {app && (
              <Button variant="ghost" size="icon-sm" onClick={() => setApp(null)} aria-label="Back to apps">
                <ArrowLeftIcon />
              </Button>
            )}
            {app ? `Choose ${mode === 'trigger' ? 'a trigger' : 'an action'} in ${app.name}` : mode === 'trigger' ? 'Choose a trigger' : 'Add an action'}
          </DialogTitle>
          <DialogDescription>{mode === 'trigger' ? 'What starts this Zap?' : 'What should happen next?'}</DialogDescription>
        </DialogHeader>

        {!app ? (
          <div className="grid gap-4">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps…" className="pl-9" />
            </div>
            <div className="grid max-h-[55dvh] gap-5 overflow-y-auto pr-1">
              {[
                ['Built-in tools', builtIn],
                ['Apps', integrations],
              ].map(([title, list]) =>
                (list as AppManifest[]).length ? (
                  <section key={title as string} className="grid gap-2">
                    <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title as string}</h3>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(list as AppManifest[]).map((a) => (
                        <button
                          key={a.key}
                          type="button"
                          onClick={() => {
                            const list = mode === 'trigger' ? a.triggers : a.actions;
                            if (list.length === 1) onPick(a.key, list[0]!.key);
                            else setApp(a);
                          }}
                          disabled={busy}
                          className="group flex items-start gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:-translate-y-px hover:border-primary/40 hover:shadow-md disabled:opacity-60"
                        >
                          <AppIcon app={a} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-sm font-medium">
                              {a.name}
                              {!a.auth.available && <Badge variant="secondary" className="text-[10px]">not configured</Badge>}
                            </span>
                            <span className="line-clamp-2 text-xs text-muted-foreground">{a.description}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null,
              )}
              {candidates.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No apps match “{q}”.</p>}
            </div>
          </div>
        ) : (
          <div className="grid gap-2">
            {ops.map((op) => (
              <button
                key={op.key}
                type="button"
                disabled={busy}
                onClick={() => onPick(app.key, op.key)}
                className="flex items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/50 disabled:opacity-60"
              >
                <ZapIcon className="mt-0.5 size-4 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {op.name}
                    {'kind' in op && (
                      <Badge variant="secondary" className={cn('text-[10px]')}>
                        {KIND_LABEL[(op as { kind: string }).kind] ?? (op as { kind: string }).kind}
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">{op.description}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
