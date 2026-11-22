'use client';

import type { ZapDetailDto } from '@flowforge/shared';
import { AlertTriangleIcon, ArrowLeftIcon, UploadIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ZapStatusBadge } from '@/components/zaps/zap-status';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';

export function BuilderHeader({
  ws,
  zap,
  issues,
  publishing,
  onRename,
  onToggle,
  onPublish,
  onShowIssue,
}: {
  ws: string;
  zap: ZapDetailDto;
  issues: Array<{ path: string; message: string }>;
  publishing: boolean;
  onRename: (name: string) => void;
  onToggle: (on: boolean) => void;
  onPublish: () => void;
  onShowIssue: (stepKey: string) => void;
}) {
  const [name, setName] = useState(zap.name);
  useEffect(() => setName(zap.name), [zap.name]);
  const on = zap.status === 'ACTIVE';

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur-md">
      <Button variant="ghost" size="icon-sm" asChild>
        <Link href={`/w/${ws}/zaps`} aria-label="Back to Zaps">
          <ArrowLeftIcon />
        </Link>
      </Button>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim() !== zap.name && onRename(name.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        maxLength={120}
        aria-label="Zap name"
        className="min-w-0 flex-1 truncate rounded-md bg-transparent px-1 text-base font-semibold outline-none hover:bg-accent/60 focus:bg-accent/60 sm:max-w-md"
      />
      <ZapStatusBadge status={zap.status} />
      {zap.publishedVersion && <span className="hidden text-xs text-muted-foreground sm:inline">v{zap.publishedVersion}</span>}
      <div className="ml-auto flex items-center gap-2">
        {issues.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="border-destructive/40 text-destructive" data-testid="issues-button">
                <AlertTriangleIcon /> {issues.length} issue{issues.length === 1 ? '' : 's'}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96 p-2">
              <p className="px-2 pb-2 text-xs font-medium text-muted-foreground">Fix these to turn the Zap on</p>
              <ul className="grid gap-1">
                {issues.map((i, n) => {
                  const stepKey = i.path.split('.')[0]!;
                  return (
                    <li key={n}>
                      <button type="button" onClick={() => onShowIssue(stepKey)} className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
                        <code className="mr-1.5 text-xs text-muted-foreground">{stepKey === 'zap' ? 'Zap' : stepKey}</code>
                        {i.message}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </PopoverContent>
          </Popover>
        )}
        {on && zap.hasUnpublishedChanges && (
          <Button size="sm" onClick={onPublish} disabled={publishing} data-testid="publish-changes">
            {publishing ? <Spinner /> : <UploadIcon />} Publish changes
          </Button>
        )}
        {!on && zap.hasUnpublishedChanges && zap.publishedVersion && <span className="hidden text-xs text-muted-foreground md:inline">Unpublished changes</span>}
        <label className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium">
          {publishing && !on ? <Spinner /> : null}
          {on ? 'On' : 'Off'}
          <Switch checked={on} disabled={publishing} onCheckedChange={onToggle} aria-label="Turn Zap on or off" data-testid="zap-toggle" />
        </label>
      </div>
    </div>
  );
}
