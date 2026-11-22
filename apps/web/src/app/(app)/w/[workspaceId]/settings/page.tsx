'use client';

import { PlusIcon } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useWorkspaceActions } from '@/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { useWorkspaceRole } from './use-role';

export default function GeneralSettingsPage() {
  const { workspaceId: ws } = useParams<{ workspaceId: string }>();
  const { workspace, role, atLeast } = useWorkspaceRole(ws);
  const actions = useWorkspaceActions();
  const router = useRouter();
  const [name, setName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  useEffect(() => setName(workspace?.name ?? ''), [workspace?.name]);
  if (!workspace) return null;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>
            You are {role === 'OWNER' ? 'an owner' : role === 'ADMIN' ? 'an admin' : 'a member'} of this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-1.5"
            id="ws-form"
            onSubmit={(e) => {
              e.preventDefault();
              actions.rename.mutate(
                { id: ws, name: name.trim() },
                { onSuccess: () => toast.success('Workspace renamed'), onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not rename') },
              );
            }}
          >
            <Label htmlFor="ws-name">Name</Label>
            <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!atLeast('ADMIN')} maxLength={80} />
            <p className="text-xs text-muted-foreground">
              Slug: <code>{workspace.slug}</code>
            </p>
          </form>
        </CardContent>
        {atLeast('ADMIN') && (
          <CardFooter className="justify-end border-t pt-4">
            <Button type="submit" form="ws-form" disabled={!name.trim() || name.trim() === workspace.name || actions.rename.isPending}>
              {actions.rename.isPending && <Spinner />} Save
            </Button>
          </CardFooter>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>New workspace</CardTitle>
          <CardDescription>Workspaces keep Zaps, connections and runs completely separate — useful for clients or teams.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button variant="outline" onClick={() => (setNewName(''), setCreateOpen(true))}>
            <PlusIcon /> Create workspace
          </Button>
        </CardFooter>
      </Card>

      {role === 'OWNER' && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">Delete workspace</CardTitle>
            <CardDescription>Permanently deletes every Zap, connection, run and API key in “{workspace.name}”. Live triggers stop immediately.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button variant="destructive" onClick={() => (setConfirmText(''), setDeleteOpen(true))}>
              Delete workspace
            </Button>
          </CardFooter>
        </Card>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <form
            className="grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const created = await actions.create.mutateAsync(newName.trim());
                toast.success(`Created ${created.name}`);
                router.push(`/w/${created.id}`);
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'Could not create workspace');
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Create a workspace</DialogTitle>
              <DialogDescription>You’ll be its owner.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="new-ws">Name</Label>
              <Input id="new-ws" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} placeholder="e.g. Acme client" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newName.trim() || actions.create.isPending}>
                {actions.create.isPending && <Spinner />} Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{workspace.name}”?</DialogTitle>
            <DialogDescription>This cannot be undone. Type the workspace name to confirm.</DialogDescription>
          </DialogHeader>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={workspace.name} aria-label="Workspace name" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={confirmText !== workspace.name || actions.remove.isPending}
              onClick={async () => {
                try {
                  await actions.remove.mutateAsync(ws);
                  toast.success('Workspace deleted');
                  router.replace('/');
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : 'Could not delete');
                }
              }}
            >
              {actions.remove.isPending && <Spinner />} Delete forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
