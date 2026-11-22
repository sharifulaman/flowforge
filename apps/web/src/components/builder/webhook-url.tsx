'use client';

import { CheckIcon, CopyIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';

export function WebhookUrl({ url, onRotate }: { url: string; onRotate: () => Promise<unknown> }) {
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="grid gap-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Your webhook URL</span>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setConfirm(true)}>
          <RefreshCwIcon className="size-3" /> New URL
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1.5 font-mono text-xs" data-testid="hook-url">
          {url}
        </code>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Copy webhook URL"
          onClick={() => {
            void navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          }}
        >
          {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Send a request here to capture sample data while the Zap is off. Add an <code>Idempotency-Key</code> header to de-duplicate retries.
      </p>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Generate a new URL?"
        description="The current URL stops working immediately. Update every service that calls it."
        confirmLabel="Generate new URL"
        onConfirm={onRotate}
      />
    </div>
  );
}
