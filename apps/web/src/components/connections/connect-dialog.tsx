'use client';

import type { AppManifest } from '@flowforge/connector-sdk';
import type { ConnectionDto } from '@flowforge/shared';
import { ExternalLinkIcon, InfoIcon, ShieldCheckIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AppIcon } from '@/components/apps/app-icon';
import { SchemaForm } from '@/components/schema-form/schema-form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { oauthStartUrl, useConnectionActions } from '@/hooks/use-builder';
import { ApiError } from '@/lib/api-client';

/**
 * Connect (or update) an account for an app. API-key apps render their credential schema;
 * OAuth apps hand off to the provider and come back to `returnTo`.
 */
export function ConnectDialog({
  ws,
  app,
  open,
  onOpenChange,
  existing,
  returnTo,
  onConnected,
}: {
  ws: string;
  app: AppManifest | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing?: ConnectionDto;
  returnTo?: string;
  onConnected?: (c: ConnectionDto) => void;
}) {
  const actions = useConnectionActions(ws);
  const [name, setName] = useState('');
  const [creds, setCreds] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(existing?.name ?? '');
      setCreds({});
      setErrors({});
      setFormError(null);
    }
  }, [open, existing]);

  if (!app) return null;
  const isOAuth = app.auth.type === 'oauth2';
  const busy = actions.create.isPending || actions.update.isPending;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    try {
      const conn = existing
        ? await actions.update.mutateAsync({ id: existing.id, name: name || undefined, credentials: creds })
        : await actions.create.mutateAsync({ appKey: app.key, name: name.trim() || undefined, credentials: creds });
      toast.success(existing ? `${conn.name} updated` : `Connected ${conn.name}`);
      onConnected?.(conn);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) {
        setErrors(Object.fromEntries(err.issues.map((i) => [i.path.replace(/^credentials\./, ''), i.message])));
      } else {
        setFormError(err instanceof ApiError ? err.message : 'Could not connect');
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AppIcon app={app} size="lg" />
            <div>
              <DialogTitle>{existing ? `Update ${existing.name}` : `Connect ${app.name}`}</DialogTitle>
              <DialogDescription>{app.description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {app.auth.instructions && (
          <div className="flex gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            <InfoIcon className="mt-0.5 size-4 shrink-0 text-primary" />
            <p>{app.auth.instructions}</p>
          </div>
        )}

        {isOAuth ? (
          <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">
              You’ll be sent to {app.name} to approve access{app.auth.scopes?.length ? ` (${app.auth.scopes.length} permissions)` : ''}, then brought back here.
            </p>
            {!app.auth.available && <p className="text-sm text-destructive">{app.name} sign-in is not configured on this server.</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button asChild disabled={!app.auth.available}>
                <a href={app.auth.available ? oauthStartUrl(ws, app.key, { connectionId: existing?.id, returnTo }) : undefined} aria-disabled={!app.auth.available}>
                  Continue to {app.name} <ExternalLinkIcon />
                </a>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4" noValidate>
            <div className="grid gap-1.5">
              <Label htmlFor="conn-name">Connection name</Label>
              <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${app.name} – Production`} />
            </div>
            {app.auth.fields && <SchemaForm schema={app.auth.fields} value={creds} onChange={setCreds} templates={false} errors={errors} idPrefix="cred" />}
            {formError && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {formError}
              </p>
            )}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheckIcon className="size-3.5" /> Credentials are verified, then encrypted with AES-256-GCM. They are never shown again.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Spinner />}
                {busy ? 'Verifying…' : existing ? 'Save' : 'Connect'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
