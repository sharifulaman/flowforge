'use client';

import type { MemberDto, WorkspaceRole } from '@flowforge/shared';
import { UserPlusIcon } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useMemberActions, useMembers } from '@/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { initials } from '@/lib/utils';
import { useWorkspaceRole } from '../use-role';

const ROLE_LABEL: Record<WorkspaceRole, string> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };

export default function MembersPage() {
  const { workspaceId: ws } = useParams<{ workspaceId: string }>();
  const { role, userId, atLeast } = useWorkspaceRole(ws);
  const members = useMembers(ws);
  const actions = useMemberActions(ws);
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<WorkspaceRole>('MEMBER');
  const [removing, setRemoving] = useState<MemberDto | null>(null);
  const toastErr = (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Something went wrong');

  return (
    <div className="grid gap-6">
      {atLeast('ADMIN') && (
        <Card>
          <CardHeader>
            <CardTitle>Add a member</CardTitle>
            <CardDescription>They need a FlowForge account already.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await actions.add.mutateAsync({ email: email.trim(), role: newRole });
                  toast.success(`Added ${email.trim()}`);
                  setEmail('');
                } catch (err) {
                  toastErr(err);
                }
              }}
            >
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" aria-label="Email" className="flex-1" />
              <Select value={newRole} onValueChange={(v) => setNewRole(v as WorkspaceRole)}>
                <SelectTrigger className="sm:w-32" aria-label="Role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">Member</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                  {role === 'OWNER' && <SelectItem value="OWNER">Owner</SelectItem>}
                </SelectContent>
              </Select>
              <Button type="submit" disabled={!email.trim() || actions.add.isPending}>
                {actions.add.isPending ? <Spinner /> : <UserPlusIcon />} Add
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card className="gap-0 py-0">
        {members.isLoading ? (
          <div className="grid gap-2 p-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : (
          <ul className="divide-y">
            {members.data?.map((m) => {
              const isSelf = m.userId === userId;
              const canEdit = atLeast('ADMIN') && !isSelf && (m.role !== 'OWNER' || role === 'OWNER');
              return (
                <li key={m.id} className="flex items-center gap-3 px-4 py-3" data-testid="member-row">
                  <Avatar>
                    {m.avatarUrl && <AvatarImage src={m.avatarUrl} alt="" referrerPolicy="no-referrer" />}
                    <AvatarFallback>{initials(m.name ?? m.email)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {m.name ?? m.email} {isSelf && <Badge variant="secondary" className="ml-1">You</Badge>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                  </div>
                  {canEdit ? (
                    <Select value={m.role} onValueChange={(v) => actions.setRole.mutate({ id: m.id, role: v as WorkspaceRole }, { onError: toastErr, onSuccess: () => toast.success('Role updated') })}>
                      <SelectTrigger className="w-28" aria-label={`Role of ${m.email}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MEMBER">Member</SelectItem>
                        <SelectItem value="ADMIN">Admin</SelectItem>
                        {role === 'OWNER' && <SelectItem value="OWNER">Owner</SelectItem>}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="w-28 text-right text-sm text-muted-foreground">{ROLE_LABEL[m.role]}</span>
                  )}
                  {(canEdit || isSelf) && (
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRemoving(m)}>
                      {isSelf ? 'Leave' : 'Remove'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing?.userId === userId ? 'Leave this workspace?' : `Remove ${removing?.email}?`}
        description={removing?.userId === userId ? 'You will lose access immediately.' : 'Their API keys for this workspace stop working too.'}
        confirmLabel={removing?.userId === userId ? 'Leave' : 'Remove'}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await actions.remove.mutateAsync(removing.id);
            if (removing.userId === userId) router.replace('/');
          } catch (err) {
            toastErr(err);
          }
        }}
      />
    </div>
  );
}
