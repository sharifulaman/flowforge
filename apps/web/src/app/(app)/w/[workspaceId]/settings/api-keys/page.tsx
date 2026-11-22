'use client';

import type { ApiKeyDto } from '@flowforge/shared';
import { AlertTriangleIcon, CheckIcon, CopyIcon, KeyRoundIcon, PlusIcon } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useApiKeyActions, useApiKeys } from '@/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { relativeTime } from '@/lib/time';
import { useWorkspaceRole } from '../use-role';

export default function ApiKeysPage() {
  const { workspaceId: ws } = useParams<{ workspaceId: string }>();
  const { atLeast } = useWorkspaceRole(ws);
  const isAdmin = atLeast('ADMIN');
  const keys = useApiKeys(ws, isAdmin);
  const actions = useApiKeyActions(ws);
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyDto | null>(null);

  if (!isAdmin) return <EmptyState icon={KeyRoundIcon} title="Admins only" description="Ask a workspace admin to create an API key for you." />;

  const status = (k: ApiKeyDto) =>
    k.revokedAt ? <Badge variant="secondary">Revoked</Badge> : k.expiresAt && Date.parse(k.expiresAt) < Date.now() ? <Badge variant="warning">Expired</Badge> : <Badge variant="success">Active</Badge>;

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Use keys to call the API: <code className="rounded bg-muted px-1">Authorization: Bearer ff_live_…</code>. Keys act with their creator’s role.
        </p>
        <Button onClick={() => setCreateOpen(true)} data-testid="create-api-key">
          <PlusIcon /> New key
        </Button>
      </div>
      {keys.isLoading ? (
        <Skeleton className="h-32" />
      ) : !keys.data?.length ? (
        <EmptyState icon={KeyRoundIcon} title="No API keys" description="Create a key to manage Zaps and read runs from scripts or CI." />
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Key</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Last used</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Expires</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y">
              {keys.data.map((k) => (
                <tr key={k.id} data-testid="api-key-row">
                  <td className="px-4 py-3 font-medium">{k.name}</td>
                  <td className="px-4 py-3">
                    <code className="text-xs text-muted-foreground">{k.prefix}…</code>
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-muted-foreground sm:table-cell">{k.lastUsedAt ? relativeTime(k.lastUsedAt) : 'Never'}</td>
                  <td className="hidden px-4 py-3 text-xs text-muted-foreground md:table-cell">{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'Never'}</td>
                  <td className="px-4 py-3">{status(k)}</td>
                  <td className="px-4 py-3 text-right">
                    {!k.revokedAt && (
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRevoking(k)}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} create={actions.create.mutateAsync} busy={actions.create.isPending} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke “${revoking?.name}”?`}
        description="Requests using this key will fail immediately."
        confirmLabel="Revoke"
        onConfirm={() => (revoking ? actions.revoke.mutateAsync(revoking.id).then(() => toast.success('Key revoked')) : undefined)}
      />
    </div>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  create,
  busy,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  create: (b: { name: string; expiresInDays?: number }) => Promise<ApiKeyDto & { key: string }>;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const close = (o: boolean) => {
    if (!o) {
      setName('');
      setCreated(null);
      setCopied(false);
    }
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        {created ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Copy your API key</DialogTitle>
              <DialogDescription>This is the only time it will be shown.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 rounded-md border bg-muted/40 px-2 py-2 font-mono text-xs break-all" data-testid="new-api-key">
                {created}
              </code>
              <Button
                size="icon"
                variant="outline"
                aria-label="Copy key"
                onClick={() => {
                  void navigator.clipboard.writeText(created);
                  setCopied(true);
                }}
              >
                {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
              </Button>
            </div>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" /> Store it in a secret manager. Anyone with this key can manage this workspace’s Zaps.
            </p>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const res = await create({ name: name.trim(), expiresInDays: expiry === 'never' ? undefined : Number(expiry) });
                setCreated(res.key);
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'Could not create key');
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CI deploy" maxLength={80} />
            </div>
            <div className="grid gap-1.5">
              <Label>Expires</Label>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger aria-label="Expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">In 30 days</SelectItem>
                  <SelectItem value="90">In 90 days</SelectItem>
                  <SelectItem value="365">In 1 year</SelectItem>
                  <SelectItem value="never">Never</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || busy}>
                {busy && <Spinner />} Create key
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
