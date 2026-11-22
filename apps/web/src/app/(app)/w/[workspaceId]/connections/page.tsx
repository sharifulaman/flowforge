'use client';

import type { AppManifest } from '@flowforge/connector-sdk';
import type { ConnectionDto } from '@flowforge/shared';
import { MoreHorizontalIcon, PencilIcon, PlugIcon, PlusIcon, RefreshCwIcon, SearchIcon, ShieldCheckIcon, Trash2Icon } from 'lucide-react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AppIcon } from '@/components/apps/app-icon';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { ConnectDialog } from '@/components/connections/connect-dialog';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useApps, useConnectionActions, useConnections } from '@/hooks/use-builder';
import { ApiError } from '@/lib/api-client';
import { relativeTime } from '@/lib/time';

function ConnectionsInner() {
  const { workspaceId: ws } = useParams<{ workspaceId: string }>();
  const apps = useApps();
  const conns = useConnections(ws);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [chooser, setChooser] = useState(false);
  const [connectApp, setConnectApp] = useState<AppManifest | undefined>();

  useEffect(() => {
    const connected = params.get('connected');
    const error = params.get('error');
    if (connected) toast.success('Account connected');
    if (error) toast.error(error);
    if (connected || error) router.replace(pathname);
  }, [params, pathname, router]);

  const connectable = (apps.data?.list ?? []).filter((a) => a.auth.type !== 'none');

  return (
    <>
      <PageHeader
        title="Connections"
        description="Accounts your Zaps use. Credentials are encrypted at rest and never shown again."
        actions={
          <Button onClick={() => setChooser(true)} data-testid="add-connection">
            <PlusIcon /> Add connection
          </Button>
        }
      />
      {conns.isLoading || apps.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : !conns.data?.length ? (
        <EmptyState
          icon={PlugIcon}
          title="No connections yet"
          description="Connect Slack, Google Sheets, Telegram, email and more. You can also connect accounts while building a Zap."
          action={
            <Button onClick={() => setChooser(true)}>
              <PlusIcon /> Add connection
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {conns.data.map((c) => (
            <ConnectionCard key={c.id} ws={ws} conn={c} app={apps.data?.byKey.get(c.appKey)} />
          ))}
        </div>
      )}

      <Dialog open={chooser} onOpenChange={setChooser}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Add a connection</DialogTitle>
            <DialogDescription>Choose the app to connect.</DialogDescription>
          </DialogHeader>
          <AppChooser
            apps={connectable}
            onPick={(a) => {
              setChooser(false);
              setConnectApp(a);
            }}
          />
        </DialogContent>
      </Dialog>
      <ConnectDialog ws={ws} app={connectApp} open={!!connectApp} onOpenChange={(o) => !o && setConnectApp(undefined)} />
    </>
  );
}

function AppChooser({ apps, onPick }: { apps: AppManifest[]; onPick: (a: AppManifest) => void }) {
  const [q, setQ] = useState('');
  const list = apps.filter((a) => a.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="grid gap-3">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps…" className="pl-9" />
      </div>
      <div className="grid max-h-96 gap-2 overflow-y-auto sm:grid-cols-2">
        {list.map((a) => (
          <button key={a.key} type="button" onClick={() => onPick(a)} className="flex items-center gap-3 rounded-lg border p-3 text-left transition-all hover:border-primary/40 hover:shadow-sm">
            <AppIcon app={a} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{a.name}</span>
              <span className="block text-xs text-muted-foreground">{a.auth.type === 'oauth2' ? 'Sign in' : 'API key'}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ConnectionCard({ ws, conn, app }: { ws: string; conn: ConnectionDto; app?: AppManifest }) {
  const actions = useConnectionActions(ws);
  const [confirm, setConfirm] = useState(false);
  const [edit, setEdit] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(conn.name);
  const statusVariant = conn.status === 'ACTIVE' ? 'success' : conn.status === 'EXPIRED' ? 'destructive' : 'warning';

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md" data-testid="connection-card">
      <div className="flex items-start gap-3">
        <AppIcon app={app} size="lg" />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                setRenaming(false);
                if (name.trim() && name.trim() !== conn.name) actions.update.mutate({ id: conn.id, name: name.trim() });
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              className="h-7"
            />
          ) : (
            <p className="truncate font-medium">{conn.name}</p>
          )}
          <p className="truncate text-xs text-muted-foreground">
            {app?.name ?? conn.appKey}
            {typeof conn.displayInfo?.label === 'string' && conn.displayInfo.label !== conn.name ? ` · ${conn.displayInfo.label}` : ''}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Connection actions">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() =>
                actions.test.mutate(conn.id, {
                  onSuccess: () => toast.success('Connection works'),
                  onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Test failed'),
                })
              }
            >
              <ShieldCheckIcon /> Test
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <PencilIcon /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setEdit(true)}>
              <RefreshCwIcon /> {conn.authType === 'OAUTH2' ? 'Reconnect' : 'Update credentials'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
              <Trash2Icon /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={statusVariant}>{conn.status === 'ACTIVE' ? 'Connected' : conn.status.toLowerCase()}</Badge>
        <span>
          Used by {conn.usedBySteps} step{conn.usedBySteps === 1 ? '' : 's'}
        </span>
        <span>· Last used {relativeTime(conn.lastUsedAt)}</span>
      </div>
      {conn.lastError && conn.status !== 'ACTIVE' && <p className="text-xs text-destructive">{conn.lastError}</p>}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${conn.name}?`}
        description="Steps using this account will need a new one. Deletion is blocked while an active Zap uses it."
        onConfirm={() =>
          actions.remove.mutateAsync(conn.id).then(
            () => toast.success('Connection deleted'),
            (e) => toast.error(e instanceof ApiError ? e.message : 'Could not delete'),
          )
        }
      />
      <ConnectDialog ws={ws} app={app} existing={conn} open={edit} onOpenChange={setEdit} />
    </div>
  );
}

export default function ConnectionsPage() {
  return (
    <Suspense>
      <ConnectionsInner />
    </Suspense>
  );
}
