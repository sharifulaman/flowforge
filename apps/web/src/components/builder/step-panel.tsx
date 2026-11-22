'use client';

import type { AppManifest } from '@flowforge/connector-sdk';
import type { StepDto, ZapDetailDto } from '@flowforge/shared';
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, RepeatIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AppIcon } from '@/components/apps/app-icon';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ConnectionPicker } from '@/components/connections/connection-picker';
import { SchemaForm } from '@/components/schema-form/schema-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type StepSample, useZapActions } from '@/hooks/use-builder';
import { ApiError } from '@/lib/api-client';
import { AppPickerDialog } from './app-picker-dialog';
import { operationOf, setupProblems, type StepIssue } from './builder-utils';
import { TemplateProvider } from './template-context';
import { TestPanel } from './test-panel';
import { WebhookUrl } from './webhook-url';

const AUTOSAVE_MS = 600;

export function StepPanel({
  ws,
  zap,
  step,
  apps,
  samples,
  issues,
  onClose,
}: {
  ws: string;
  zap: ZapDetailDto;
  step: StepDto;
  apps: Map<string, AppManifest>;
  samples: StepSample[];
  issues: StepIssue[];
  onClose: () => void;
}) {
  const actions = useZapActions(ws, zap.id);
  const app = apps.get(step.appKey);
  const op = operationOf(step, app);
  const isTrigger = step.type === 'TRIGGER';
  const [tab, setTab] = useState('setup');
  const [picker, setPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ── Config with debounced autosave ───────────────────────
  const [config, setConfig] = useState<Record<string, unknown>>(step.config);
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saving' | 'saved'>('idle');
  const pending = useRef<Record<string, unknown> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const persist = async (cfg: Record<string, unknown>) => {
    setSaveState('saving');
    try {
      if (isTrigger) await actions.setTrigger.mutateAsync({ appKey: step.appKey, operationKey: step.operationKey, connectionId: step.connectionId, config: cfg, name: step.name ?? undefined });
      else await actions.updateStep.mutateAsync({ stepId: step.id, config: cfg });
      setSaveState('saved');
    } catch (err) {
      setSaveState('idle');
      toast.error(err instanceof ApiError ? err.message : 'Could not save');
    }
  };

  const flush = () => {
    clearTimeout(timer.current);
    if (pending.current) {
      const cfg = pending.current;
      pending.current = null;
      void persist(cfg);
    }
  };

  // Reset local state when switching steps; save anything pending for the previous one.
  useEffect(() => {
    setConfig(step.config);
    setSaveState('idle');
    setTab('setup');
    return flush;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  const onConfigChange = (next: Record<string, unknown>) => {
    setConfig(next);
    pending.current = next;
    setSaveState('pending');
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  };

  // ── Data for the field picker ────────────────────────────
  const previous = useMemo(() => {
    if (isTrigger) return [];
    return samples.filter((s) => s.type === 'TRIGGER' || (s.type === 'ACTION' && s.position < step.position));
  }, [samples, isTrigger, step.position]);

  const fieldErrors = Object.fromEntries(issues.filter((i) => i.field).map((i) => [i.field!.replace(/^connectionId$/, '__connection'), i.message]));
  const generalIssues = issues.filter((i) => !i.field);

  const actionSteps = zap.steps.filter((s) => s.type === 'ACTION');
  const idx = actionSteps.findIndex((s) => s.id === step.id);
  const move = (dir: -1 | 1) => {
    const order = actionSteps.map((s) => s.id);
    const [moved] = order.splice(idx, 1);
    order.splice(idx + dir, 0, moved!);
    actions.reorder.mutate(order, { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not reorder') });
  };

  const problems = setupProblems({ ...step, config }, app);
  const returnTo = typeof window !== 'undefined' ? `${window.location.pathname}?step=${step.id}` : undefined;

  return (
    <aside className="flex h-full w-full flex-col border-l bg-background animate-in slide-in-from-right-4 fade-in-0 duration-200" data-testid="step-panel">
      <header className="flex items-start gap-3 border-b p-4">
        <AppIcon app={app} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground uppercase">
            {isTrigger ? 'Trigger' : `Action · ${step.key}`}
          </p>
          <StepName
            value={step.name ?? ''}
            placeholder={op?.name ?? step.operationKey}
            onSave={(name) =>
              isTrigger
                ? actions.setTrigger.mutateAsync({ appKey: step.appKey, operationKey: step.operationKey, connectionId: step.connectionId, config, name: name || undefined })
                : actions.updateStep.mutateAsync({ stepId: step.id, name: name || null })
            }
          />
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel">
          <XIcon />
        </Button>
      </header>

      <Tabs value={tab} onValueChange={(t) => (flush(), setTab(t))} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <TabsList>
            <TabsTrigger value="setup">Setup</TabsTrigger>
            <TabsTrigger value="test">Test</TabsTrigger>
          </TabsList>
          <SaveIndicator state={saveState} />
        </div>

        <TabsContent value="setup" className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid gap-5">
            {generalIssues.length > 0 && (
              <ul className="grid gap-1 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {generalIssues.map((i, n) => (
                  <li key={n}>{i.message}</li>
                ))}
              </ul>
            )}

            <div className="grid gap-1.5">
              <Label>App & event</Label>
              <div className="flex gap-2">
                <Select
                  value={step.operationKey}
                  onValueChange={(operationKey) =>
                    isTrigger
                      ? actions.setTrigger.mutate({ appKey: step.appKey, operationKey, connectionId: step.connectionId, config: {} })
                      : actions.updateStep.mutate({ stepId: step.id, operationKey })
                  }
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(isTrigger ? app?.triggers : app?.actions)?.map((o) => (
                      <SelectItem key={o.key} value={o.key}>
                        {app?.name} · {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="icon" onClick={() => setPicker(true)} aria-label="Change app">
                  <RepeatIcon />
                </Button>
              </div>
              {op && <p className="text-xs text-muted-foreground">{op.description}</p>}
            </div>

            {app && app.auth.type !== 'none' && (
              <div className="grid gap-1.5">
                <Label>Account</Label>
                <ConnectionPicker
                  ws={ws}
                  app={app}
                  value={step.connectionId}
                  returnTo={returnTo}
                  invalid={!!fieldErrors.__connection}
                  onChange={(connectionId) =>
                    isTrigger
                      ? actions.setTrigger.mutate({ appKey: step.appKey, operationKey: step.operationKey, connectionId, config })
                      : actions.updateStep.mutate({ stepId: step.id, connectionId })
                  }
                />
                {fieldErrors.__connection && <p className="text-xs text-destructive">{fieldErrors.__connection}</p>}
              </div>
            )}

            {isTrigger && zap.trigger.hookUrl && <WebhookUrl url={zap.trigger.hookUrl} onRotate={() => actions.rotateToken.mutateAsync()} />}

            {op && Object.keys(op.input.properties).length > 0 && (
              <TemplateProvider value={isTrigger ? null : { previous, apps }}>
                <SchemaForm
                  key={step.id}
                  schema={op.input}
                  value={config}
                  onChange={onConfigChange}
                  templates={!isTrigger}
                  errors={fieldErrors}
                  options={{ ws, appKey: step.appKey, connectionId: step.connectionId }}
                  idPrefix={step.key}
                />
              </TemplateProvider>
            )}

            {!isTrigger && (
              <div className="grid gap-1.5">
                <Label htmlFor="timeout">Timeout (seconds)</Label>
                <Input
                  id="timeout"
                  type="number"
                  min={1}
                  max={300}
                  className="w-32"
                  placeholder={String(Math.round(((op as { timeoutMs?: number } | undefined)?.timeoutMs ?? 30_000) / 1000))}
                  defaultValue={step.timeoutMs ? step.timeoutMs / 1000 : ''}
                  key={`${step.id}-timeout`}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    const ms = v ? Math.min(300, Math.max(1, Number(v))) * 1000 : null;
                    if (ms !== step.timeoutMs) actions.updateStep.mutate({ stepId: step.id, timeoutMs: ms });
                  }}
                />
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="test" className="min-h-0 flex-1 overflow-y-auto p-4">
          <TestPanel ws={ws} zapId={zap.id} step={step} hookUrl={zap.trigger.hookUrl} disabledReason={saveState === 'pending' || saveState === 'saving' ? 'Saving…' : problems[0]} />
        </TabsContent>
      </Tabs>

      {!isTrigger && (
        <footer className="flex items-center gap-1 border-t p-3">
          <Button variant="ghost" size="sm" disabled={idx <= 0 || actions.reorder.isPending} onClick={() => move(-1)}>
            <ArrowUpIcon /> Up
          </Button>
          <Button variant="ghost" size="sm" disabled={idx === actionSteps.length - 1 || actions.reorder.isPending} onClick={() => move(1)}>
            <ArrowDownIcon /> Down
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2Icon /> Delete
          </Button>
        </footer>
      )}

      <AppPickerDialog
        open={picker}
        onOpenChange={setPicker}
        mode={isTrigger ? 'trigger' : 'action'}
        apps={[...apps.values()]}
        busy={actions.setTrigger.isPending || actions.updateStep.isPending}
        onPick={async (appKey, operationKey) => {
          if (isTrigger) await actions.setTrigger.mutateAsync({ appKey, operationKey, connectionId: null, config: {} });
          else await actions.updateStep.mutateAsync({ stepId: step.id, appKey, operationKey });
          setPicker(false);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete step ${step.key}?`}
        description="Later steps that use its data will need to be updated."
        onConfirm={async () => {
          await actions.deleteStep.mutateAsync(step.id);
          onClose();
        }}
      />
    </aside>
  );
}

function SaveIndicator({ state }: { state: 'idle' | 'pending' | 'saving' | 'saved' }) {
  if (state === 'idle') return null;
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="save-state">
      {state === 'saved' ? <CheckIcon className="size-3.5 text-success" /> : <Spinner className="size-3" />}
      {state === 'saved' ? 'Saved' : 'Saving…'}
    </span>
  );
}

function StepName({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (v: string) => Promise<unknown> }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() !== value && void onSave(v.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className="w-full truncate rounded-md bg-transparent text-base font-semibold outline-none placeholder:text-foreground hover:bg-accent/60 focus:bg-accent/60 focus:px-1"
      aria-label="Step name"
      maxLength={100}
    />
  );
}
