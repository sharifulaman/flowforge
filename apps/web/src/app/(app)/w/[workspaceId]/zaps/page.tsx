'use client';

import type { ZapStatus, ZapSummaryDto } from '@flowforge/shared';
import { CopyIcon, MoreHorizontalIcon, PlusIcon, SearchIcon, Trash2Icon, WorkflowIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AppIcon } from '@/components/apps/app-icon';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageHeader } from '@/components/layout/page-header';
import { ZapStatusBadge } from '@/components/zaps/zap-status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApps, useCreateZap, useZapList, useZapListActions } from '@/hooks/use-builder';
import { ApiError } from '@/lib/api-client';
import { relativeTime } from '@/lib/time';

type Filter = 'all' | ZapStatus;

export default function ZapsPage() {
  const { workspaceId: ws } = useParams<{ workspaceId: string }>();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useZapList(ws, { q: q || undefined, status: filter === 'all' ? undefined : filter });
  const zaps = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!q || filter !== 'all';

  return (
    <>
      <PageHeader
        title="Zaps"
        description="Automated workflows that run when something happens."
        actions={
          <Button onClick={() => setCreateOpen(true)} data-testid="create-zap">
            <PlusIcon /> Create Zap
          </Button>
        }
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="ACTIVE">On</TabsTrigger>
            <TabsTrigger value="PAUSED">Off</TabsTrigger>
            <TabsTrigger value="DRAFT">Drafts</TabsTrigger>
            <TabsTrigger value="ERROR">Errors</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search Zaps…" className="pl-9" aria-label="Search Zaps" />
        </div>
      </div>

      {list.isLoading ? (
        <div className="grid gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[68px] rounded-xl" />
          ))}
        </div>
      ) : zaps.length === 0 ? (
        <EmptyState
          icon={WorkflowIcon}
          title={filtered ? 'No matching Zaps' : 'No Zaps yet'}
          description={filtered ? 'Try a different search or filter.' : 'Create your first Zap to connect your apps and automate work.'}
          action={
            !filtered && (
              <Button onClick={() => setCreateOpen(true)}>
                <PlusIcon /> Create your first Zap
              </Button>
            )
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <ul className="divide-y">
            {zaps.map((z) => (
              <ZapRow key={z.id} ws={ws} zap={z} />
            ))}
          </ul>
          {list.hasNextPage && (
            <div className="border-t p-2 text-center">
              <Button variant="ghost" size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                {list.isFetchingNextPage && <Spinner />} Load more
              </Button>
            </div>
          )}
        </div>
      )}
      <CreateZapDialog ws={ws} open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

function ZapRow({ ws, zap }: { ws: string; zap: ZapSummaryDto }) {
  const apps = useApps();
  const actions = useZapListActions(ws);
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const on = zap.status === 'ACTIVE';

  return (
    <li className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent/40">
      <div className="flex -space-x-1.5">
        {zap.apps.length === 0 ? (
          <span className="flex size-8 items-center justify-center rounded-lg border border-dashed text-muted-foreground">
            <WorkflowIcon className="size-4" />
          </span>
        ) : (
          zap.apps.slice(0, 4).map((k, i) => <AppIcon key={i} app={apps.data?.byKey.get(k)} className="ring-2 ring-card" />)
        )}
      </div>
      <Link href={`/w/${ws}/zaps/${zap.id}`} className="min-w-0 flex-1">
        <span className="block truncate font-medium group-hover:text-primary">{zap.name}</span>
        <span className="block text-xs text-muted-foreground">
          Edited {relativeTime(zap.updatedAt)}
          {zap.publishedVersion ? ` · v${zap.publishedVersion}` : ''}
        </span>
      </Link>
      <ZapStatusBadge status={zap.status} />
      <Switch
        checked={on}
        disabled={actions.toggle.isPending || zap.apps.length < 2}
        title={zap.apps.length < 2 ? 'Add a trigger and an action first' : undefined}
        aria-label={`Turn ${zap.name} ${on ? 'off' : 'on'}`}
        onCheckedChange={(next) =>
          actions.toggle.mutate(
            { id: zap.id, on: next },
            {
              onError: (err) => {
                if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
                  toast.error('This Zap has setup issues', { action: { label: 'Fix', onClick: () => router.push(`/w/${ws}/zaps/${zap.id}`) } });
                } else toast.error(err instanceof ApiError ? err.message : 'Could not update');
              },
            },
          )
        }
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Zap actions">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => actions.duplicate.mutate(zap.id, { onSuccess: () => toast.success('Zap duplicated') })}>
            <CopyIcon /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
            <Trash2Icon /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete “${zap.name}”?`}
        description="The Zap stops immediately. Its run history is kept."
        onConfirm={() => actions.remove.mutateAsync(zap.id).then(() => toast.success('Zap deleted'))}
      />
    </li>
  );
}

function CreateZapDialog({ ws, open, onOpenChange }: { ws: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateZap(ws);
  const router = useRouter();
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const zap = await create.mutateAsync({ name: name.trim() || 'Untitled Zap' });
              router.push(`/w/${ws}/zaps/${zap.id}`);
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Could not create Zap');
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Create a Zap</DialogTitle>
            <DialogDescription>Give it a name. You can change it later.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="zap-name">Name</Label>
            <Input id="zap-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New leads → Slack" maxLength={120} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner />} Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
