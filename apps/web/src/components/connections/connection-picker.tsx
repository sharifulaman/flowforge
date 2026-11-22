'use client';

import type { AppManifest } from '@flowforge/connector-sdk';
import { AlertTriangleIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useConnections } from '@/hooks/use-builder';
import { ConnectDialog } from './connect-dialog';

const NEW = '__new__';

export function ConnectionPicker({
  ws,
  app,
  value,
  onChange,
  returnTo,
  invalid,
}: {
  ws: string;
  app: AppManifest;
  value: string | null;
  onChange: (id: string | null) => void;
  returnTo?: string;
  invalid?: boolean;
}) {
  const { data, isLoading } = useConnections(ws);
  const [dialog, setDialog] = useState(false);
  if (isLoading) return <Skeleton className="h-9 w-full" />;

  const mine = (data ?? []).filter((c) => c.appKey === app.key);
  const selected = mine.find((c) => c.id === value);

  if (mine.length === 0) {
    return (
      <>
        <Button type="button" variant="outline" className="w-full justify-start" onClick={() => setDialog(true)} aria-invalid={invalid || undefined}>
          <PlusIcon /> Connect a {app.name} account
        </Button>
        <ConnectDialog ws={ws} app={app} open={dialog} onOpenChange={setDialog} returnTo={returnTo} onConnected={(c) => onChange(c.id)} />
      </>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Select value={selected ? selected.id : undefined} onValueChange={(v) => (v === NEW ? setDialog(true) : onChange(v))}>
        <SelectTrigger aria-invalid={invalid || undefined} aria-label={`${app.name} account`}>
          <SelectValue placeholder={`Choose a ${app.name} account`} />
        </SelectTrigger>
        <SelectContent>
          {mine.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
              {c.status !== 'ACTIVE' && ` · ${c.status.toLowerCase()}`}
            </SelectItem>
          ))}
          <SelectItem value={NEW}>+ Connect another account</SelectItem>
        </SelectContent>
      </Select>
      {selected && selected.status !== 'ACTIVE' && (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <AlertTriangleIcon className="size-3.5" /> {selected.lastError ?? 'This account needs attention.'} Reconnect it on the Connections page.
        </p>
      )}
      <ConnectDialog ws={ws} app={app} open={dialog} onOpenChange={setDialog} returnTo={returnTo} onConnected={(c) => onChange(c.id)} />
    </div>
  );
}
