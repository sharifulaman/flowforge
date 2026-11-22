'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

/** Syntax-tinted, copyable JSON block. */
export function JsonView({ value, className, maxHeight = 'max-h-80' }: { value: unknown; className?: string; maxHeight?: string }) {
  const [copied, setCopied] = useState(false);
  const text = value === undefined ? 'undefined' : JSON.stringify(value, null, 2);
  const html = escapeHtml(text).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi,
    (_m, str: string | undefined, colon: string | undefined, kw: string | undefined, num: string | undefined) => {
      if (str) return colon ? `<span class="text-sky-600 dark:text-sky-400">${str}</span>${colon}` : `<span class="text-emerald-700 dark:text-emerald-400">${str}</span>`;
      if (kw) return `<span class="text-violet-600 dark:text-violet-400">${kw}</span>`;
      return `<span class="text-amber-700 dark:text-amber-400">${num}</span>`;
    },
  );
  return (
    <div className={cn('group relative min-w-0 max-w-full rounded-lg border bg-muted/40', className)}>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1_200);
        }}
        className="absolute top-2 right-2 rounded-md border bg-background p-1 opacity-0 shadow-xs transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        aria-label="Copy JSON"
      >
        {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
      </button>
      <pre className={cn('overflow-auto p-3 font-mono text-xs leading-relaxed', maxHeight)} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
