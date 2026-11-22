'use client';

import { BracesIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { insertAt, splitTemplate } from '@/lib/template-utils';
import { cn } from '@/lib/utils';
import { FieldPicker } from './field-picker';
import { useTemplateContext } from './template-context';

/**
 * Text field that highlights {{ references }} and offers an "insert data" picker.
 * Highlighting uses a mirrored backdrop behind a transparent-background textarea.
 */
export function TemplateInput({
  id,
  value,
  onChange,
  placeholder,
  multiline = false,
  mono = false,
  invalid,
  templates = true,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  invalid?: boolean;
  templates?: boolean;
}) {
  const ctx = useTemplateContext();
  const ref = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const selection = useRef<{ start: number; end: number }>({ start: value.length, end: value.length });
  const [pickerOpen, setPickerOpen] = useState(false);
  const canInsert = templates && !!ctx;

  // Auto-size to content.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, multiline ? 320 : 120)}px`;
  }, [value, multiline]);

  const remember = () => {
    const el = ref.current;
    if (el) selection.current = { start: el.selectionStart, end: el.selectionEnd };
  };

  const insert = (snippet: string) => {
    const { value: next, caret } = insertAt(value, snippet, selection.current.start, selection.current.end);
    onChange(next);
    setPickerOpen(false);
    // Focus now (synchronously) so it can't steal focus from whatever the user clicks next;
    // only the caret placement waits for React to commit the new value.
    ref.current?.focus();
    selection.current = { start: caret, end: caret };
    requestAnimationFrame(() => {
      if (document.activeElement === ref.current) ref.current?.setSelectionRange(caret, caret);
    });
  };

  const shared = cn('px-3 py-2 text-sm leading-6 whitespace-pre-wrap break-words', mono && 'font-mono text-[13px]', canInsert && 'pr-9');

  return (
    <div className="group/ti relative">
      <div
        ref={backdrop}
        aria-hidden
        className={cn(shared, 'pointer-events-none absolute inset-0 overflow-hidden rounded-md border border-transparent text-transparent')}
      >
        {splitTemplate(value).map((p, i) =>
          p.isRef ? (
            <mark key={i} className="rounded bg-primary/15 text-transparent ring-1 ring-primary/25">
              {p.text}
            </mark>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
        {'​'}
      </div>
      <textarea
        ref={ref}
        id={id}
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        onChange={(e) => {
          onChange(multiline ? e.target.value : e.target.value.replace(/\n/g, ' '));
          remember();
        }}
        onSelect={remember}
        onBlur={remember}
        onKeyDown={(e) => {
          if (!multiline && e.key === 'Enter') e.preventDefault();
        }}
        onScroll={(e) => {
          if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
        }}
        className={cn(
          shared,
          'relative block w-full resize-none overflow-y-auto rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 aria-invalid:border-destructive',
          multiline && 'min-h-20',
        )}
      />
      {canInsert && (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              onMouseDown={remember}
              className="absolute top-1.5 right-1.5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
              aria-label="Insert data from a previous step"
              data-testid="insert-data"
            >
              <BracesIcon className="size-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96 p-2" onCloseAutoFocus={(e) => e.preventDefault()}>
            <FieldPicker ctx={ctx} onPick={insert} />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
