'use client';

import { AlertTriangleIcon, SearchXIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AppPickerDialog, type PickerMode } from '@/components/builder/app-picker-dialog';
import { BuilderActionsProvider } from '@/components/builder/builder-context';
import { BuilderHeader } from '@/components/builder/builder-header';
import { groupIssues } from '@/components/builder/builder-utils';
import { BuilderCanvas } from '@/components/builder/canvas';
import { StepPanel } from '@/components/builder/step-panel';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApps, useSamples, useZap, useZapActions } from '@/hooks/use-builder';
import { ApiError } from '@/lib/api-client';

function Builder() {
  const { workspaceId: ws, zapId } = useParams<{ workspaceId: string; zapId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const zap = useZap(ws, zapId);
  const apps = useApps();
  const samples = useSamples(ws, zapId);
  const actions = useZapActions(ws, zapId);

  const selectedId = params.get('step');
  const setSelected = useCallback(
    (id: string | null) => {
      const qs = new URLSearchParams(params.toString());
      if (id) qs.set('step', id);
      else qs.delete('step');
      router.replace(`${pathname}${qs.size ? `?${qs}` : ''}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);
  const grouped = useMemo(() => groupIssues(issues), [issues]);
  const [picker, setPicker] = useState<{ mode: PickerMode; afterKey?: string } | null>(null);

  // Returning from an OAuth provider (see ConnectDialog's returnTo).
  useEffect(() => {
    const connected = params.get('connected');
    const error = params.get('error');
    if (!connected && !error) return;
    if (connected) toast.success('Account connected');
    if (error) toast.error(error);
    const qs = new URLSearchParams(params.toString());
    qs.delete('connected');
    qs.delete('error');
    router.replace(`${pathname}${qs.size ? `?${qs}` : ''}`, { scroll: false });
  }, [params, pathname, router]);

  const publish = async () => {
    try {
      await actions.enable.mutateAsync();
      setIssues([]);
      toast.success('Zap is on');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        setIssues(err.issues);
        toast.error(`Fix ${err.issues.length} issue${err.issues.length === 1 ? '' : 's'} to turn this Zap on`);
        const first = zap.data?.steps.find((s) => s.key === err.issues[0]?.path.split('.')[0]);
        if (first) setSelected(first.id);
      } else {
        toast.error(err instanceof ApiError ? err.message : 'Could not turn the Zap on');
      }
    }
  };

  if (zap.isLoading || apps.isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-14 items-center gap-3 border-b px-4">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="ml-auto h-8 w-24" />
        </div>
        <div className="flex flex-1 flex-col items-center gap-16 pt-20">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[76px] w-[320px] rounded-xl" />
          ))}
        </div>
      </div>
    );
  }
  if (zap.error || !zap.data || !apps.data) {
    return (
      <div className="p-8">
        <EmptyState
          icon={SearchXIcon}
          title="Zap not found"
          description="It may have been deleted."
          action={
            <Button asChild variant="outline">
              <Link href={`/w/${ws}/zaps`}>Back to Zaps</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const z = zap.data;
  const selected = z.steps.find((s) => s.id === selectedId) ?? null;

  const onPick = async (appKey: string, operationKey: string) => {
    if (!picker) return;
    try {
      if (picker.mode === 'trigger') {
        const next = await actions.setTrigger.mutateAsync({ appKey, operationKey, config: {} });
        setSelected(next.steps.find((s) => s.type === 'TRIGGER')!.id);
      } else {
        const before = new Set(z.steps.map((s) => s.id));
        const next = await actions.addStep.mutateAsync({ appKey, operationKey, config: {}, afterKey: picker.afterKey });
        const added = next.steps.find((s) => !before.has(s.id));
        if (added) setSelected(added.id);
      }
      setPicker(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add step');
    }
  };

  return (
    <BuilderActionsProvider
      value={{
        select: setSelected,
        insertAfter: (afterKey) => setPicker({ mode: 'action', afterKey }),
        chooseTrigger: () => setPicker({ mode: 'trigger' }),
      }}
    >
      <div className="flex h-full flex-col">
        <BuilderHeader
          ws={ws}
          zap={z}
          issues={issues}
          publishing={actions.enable.isPending || actions.disable.isPending}
          onRename={(name) => actions.rename.mutate({ name })}
          onPublish={publish}
          onToggle={(on) => (on ? void publish() : actions.disable.mutate(undefined, { onSuccess: () => toast('Zap turned off') }))}
          onShowIssue={(key) => {
            const s = z.steps.find((x) => x.key === key);
            if (s) setSelected(s.id);
          }}
        />
        {z.warnings.length > 0 && (
          <div className="flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              {z.warnings.map((w, i) => (
                <p key={i}>
                  <code className="text-xs">{w.stepKey}</code> {w.message}
                </p>
              ))}
            </div>
          </div>
        )}
        <div className="relative flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <BuilderCanvas steps={z.steps} apps={apps.data.byKey} selectedId={selected?.id ?? null} issues={grouped} />
          </div>
          {selected && (
            <div className="absolute inset-0 z-10 md:static md:w-[440px] md:shrink-0">
              <StepPanel
                ws={ws}
                zap={z}
                step={selected}
                apps={apps.data.byKey}
                samples={samples.data ?? []}
                issues={grouped.get(selected.key) ?? []}
                onClose={() => setSelected(null)}
              />
            </div>
          )}
        </div>
      </div>
      <AppPickerDialog
        open={!!picker}
        onOpenChange={(o) => !o && setPicker(null)}
        mode={picker?.mode ?? 'action'}
        apps={apps.data.list}
        busy={actions.addStep.isPending || actions.setTrigger.isPending}
        onPick={onPick}
      />
    </BuilderActionsProvider>
  );
}

export default function BuilderPage() {
  return (
    <Suspense>
      <Builder />
    </Suspense>
  );
}
