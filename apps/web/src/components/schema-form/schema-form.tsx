'use client';

import type { JSONSchema, ObjectSchema } from '@flowforge/connector-sdk';
import { ChevronDownIcon, ListIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { TemplateInput } from '@/components/builder/template-input';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useDynamicOptions } from '@/hooks/use-builder';
import { ApiError } from '@/lib/api-client';
import { coerceJson, coerceNumber, stringifyForInput } from '@/lib/template-utils';
import { cn } from '@/lib/utils';

export interface SchemaFormContext {
  /** Enables dynamic dropdowns (they call the API with the selected connection). */
  options?: { ws: string; appKey: string; connectionId: string | null };
  /** Allow {{ templates }} (false for credential forms). */
  templates: boolean;
  /** Field path → error message (paths like "email" or "address.city"). */
  errors: Record<string, string>;
  /** Root config — loaders receive it and `dependsOn` reads from it. */
  root: Record<string, unknown>;
  idPrefix: string;
}

const FormCtx = createContext<SchemaFormContext | null>(null);
const useForm = () => useContext(FormCtx)!;

type OnChange = (value: unknown) => void;

/** Renders a JSON Schema object as a form. Values are kept raw (templates are strings). */
export function SchemaForm({
  schema,
  value,
  onChange,
  templates = true,
  errors = {},
  options,
  idPrefix = 'f',
}: {
  schema: ObjectSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  templates?: boolean;
  errors?: Record<string, string>;
  options?: SchemaFormContext['options'];
  idPrefix?: string;
}) {
  return (
    <FormCtx.Provider value={{ templates, errors, options, root: value, idPrefix }}>
      <ObjectFields schema={schema} value={value} onChange={(v) => onChange(v as Record<string, unknown>)} path={[]} />
    </FormCtx.Provider>
  );
}

function ObjectFields({ schema, value, onChange, path }: { schema: JSONSchema; value: unknown; onChange: OnChange; path: string[] }) {
  const obj = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const entries = Object.entries(schema.properties ?? {});
  const basic = entries.filter(([, s]) => !s['x-ui']?.advanced);
  const advanced = entries.filter(([, s]) => s['x-ui']?.advanced);
  const required = new Set(schema.required ?? []);

  const set = (key: string, v: unknown) => {
    const next = { ...obj };
    if (v === undefined || v === '') delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const render = ([key, s]: [string, JSONSchema]) => (
    <Field key={key} name={key} schema={s} required={required.has(key)} value={obj[key]} onChange={(v) => set(key, v)} path={[...path, key]} />
  );

  return (
    <div className="grid gap-4">
      {basic.map(render)}
      {advanced.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
            Advanced options
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 grid gap-4 data-[state=open]:animate-in data-[state=open]:fade-in-0">{advanced.map(render)}</CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function Field({ name, schema, value, onChange, required, path }: { name: string; schema: JSONSchema; value: unknown; onChange: OnChange; required: boolean; path: string[] }) {
  const ctx = useForm();
  const id = `${ctx.idPrefix}-${path.join('-')}`;
  const error = ctx.errors[path.join('.')];
  const ui = schema['x-ui'] ?? {};
  const label = schema.title ?? humanize(name);
  const isToggle = schema.type === 'boolean';

  const control = <Control id={id} schema={schema} value={value} onChange={onChange} path={path} invalid={!!error} />;

  if (isToggle) {
    return (
      <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
        <div className="grid gap-0.5">
          <Label htmlFor={id}>{label}</Label>
          {(schema.description || ui.help) && <p className="text-xs text-muted-foreground">{schema.description ?? ui.help}</p>}
        </div>
        {control}
      </div>
    );
  }

  return (
    <div className="grid gap-1.5" data-field={path.join('.')}>
      <Label htmlFor={id} className="gap-1">
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {control}
      {(schema.description || ui.help) && !error && <p className="text-xs text-muted-foreground">{ui.help ?? schema.description}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive animate-in fade-in-0">
          {error}
        </p>
      )}
    </div>
  );
}

function Control({ id, schema, value, onChange, path, invalid }: { id: string; schema: JSONSchema; value: unknown; onChange: OnChange; path: string[]; invalid: boolean }) {
  const ctx = useForm();
  const ui = schema['x-ui'] ?? {};
  const templates = ctx.templates && !ui.noTemplates;
  const type = Array.isArray(schema.type) ? 'scalar' : schema.type;

  if (ui.dynamicOptions && ctx.options) return <DynamicSelect id={id} schema={schema} value={value} onChange={onChange} invalid={invalid} templates={templates} />;

  if (schema.enum) {
    const labels = schema['x-enumLabels'] ?? [];
    return (
      <Select value={value === undefined ? (schema.default === undefined ? undefined : String(schema.default)) : String(value)} onValueChange={(v) => onChange(v)}>
        <SelectTrigger id={id} aria-invalid={invalid || undefined}>
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {schema.enum.map((opt, i) => (
            <SelectItem key={String(opt)} value={String(opt)}>
              {labels[i] ?? enumLabel(String(opt))}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (type === 'boolean') return <Switch id={id} checked={value === true || value === 'true'} onCheckedChange={(c) => onChange(c)} />;

  if (type === 'object' && schema.properties && Object.keys(schema.properties).length) {
    return (
      <div className="rounded-lg border bg-muted/20 p-3">
        <ObjectFields schema={schema} value={value} onChange={onChange} path={path} />
      </div>
    );
  }
  if (type === 'object' || ui.widget === 'keyvalue') return <KeyValueEditor value={value} onChange={onChange} templates={templates} idPrefix={id} />;
  if (type === 'array') return <ArrayEditor schema={schema} value={value} onChange={onChange} path={path} templates={templates} />;

  if (ui.widget === 'password') {
    return <Input id={id} type="password" autoComplete="new-password" value={stringifyForInput(value)} placeholder={ui.placeholder} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)} />;
  }
  if (ui.widget === 'code') {
    return (
      <Textarea
        id={id}
        spellCheck={false}
        rows={10}
        value={stringifyForInput(value ?? schema.default)}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-[13px] leading-6"
      />
    );
  }

  const isNumber = type === 'number' || type === 'integer' || ui.widget === 'number';
  const isJson = ui.widget === 'json';
  const parse = (raw: string) => (isNumber ? coerceNumber(raw) : isJson ? coerceJson(raw) : raw);

  if (!templates) {
    return (
      <Input
        id={id}
        inputMode={isNumber ? 'decimal' : undefined}
        value={stringifyForInput(value)}
        placeholder={ui.placeholder ?? (schema.default !== undefined ? String(schema.default) : undefined)}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(parse(e.target.value))}
      />
    );
  }
  return (
    <TemplateInput
      id={id}
      value={stringifyForInput(value)}
      onChange={(raw) => onChange(parse(raw))}
      placeholder={ui.placeholder ?? (schema.default !== undefined ? String(schema.default) : undefined)}
      multiline={ui.widget === 'textarea' || isJson}
      mono={isJson}
      invalid={invalid}
    />
  );
}

/** Dropdown fed by a connector option loader; also accepts a typed value or {{ template }}. */
function DynamicSelect({ id, schema, value, onChange, invalid, templates }: { id: string; schema: JSONSchema; value: unknown; onChange: OnChange; invalid: boolean; templates: boolean }) {
  const ctx = useForm();
  const ui = schema['x-ui'] ?? {};
  const [open, setOpen] = useState(false);
  const needsConnection = ctx.options!.connectionId === null;
  const q = useDynamicOptions(ctx.options!.ws, ctx.options!.appKey, ui.dynamicOptions, ctx.options!.connectionId, ctx.root, ui.dependsOn, open);
  const current = stringifyForInput(value);
  const selectedLabel = q.data?.find((o) => String(o.value) === current)?.label;

  return (
    <div className="grid gap-1">
      <div className="flex gap-2">
        <div className="flex-1">
          <TemplateInput id={id} value={current} onChange={onChange} placeholder={ui.placeholder ?? 'Choose or type a value'} invalid={invalid} templates={templates} />
        </div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="icon" aria-label="Choose from list" disabled={needsConnection} title={needsConnection ? 'Choose an account first' : 'Choose from list'}>
              <ListIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-1">
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-xs font-medium text-muted-foreground">{schema.title ?? 'Options'}</span>
              <Button type="button" size="icon-sm" variant="ghost" onClick={() => q.refetch()} aria-label="Refresh options">
                <RefreshCwIcon className={cn('size-3.5', q.isFetching && 'animate-spin')} />
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {q.isLoading && (
                <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                  <Spinner /> Loading…
                </div>
              )}
              {q.error && <p className="px-2 py-2 text-sm text-destructive">{q.error instanceof ApiError ? q.error.message : 'Could not load options'}</p>}
              {q.data?.length === 0 && <p className="px-2 py-2 text-sm text-muted-foreground">Nothing found.</p>}
              {q.data?.map((o) => (
                <button
                  key={String(o.value)}
                  type="button"
                  className={cn('flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', String(o.value) === current && 'bg-accent font-medium')}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {selectedLabel && <p className="text-xs text-muted-foreground">Selected: {selectedLabel}</p>}
    </div>
  );
}

function KeyValueEditor({ value, onChange, templates, idPrefix }: { value: unknown; onChange: OnChange; templates: boolean; idPrefix: string }) {
  const toRows = (v: unknown) => Object.entries((v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>).map(([k, val]) => ({ k, v: stringifyForInput(val) }));
  const [rows, setRows] = useState(() => toRows(value));
  // Re-sync when the value changes from outside (e.g. switching steps).
  const external = JSON.stringify(value ?? {});
  useEffect(() => {
    const local = JSON.stringify(Object.fromEntries(rows.filter((r) => r.k).map((r) => [r.k, r.v])));
    if (local !== external) setRows(toRows(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [external]);

  const commit = (next: Array<{ k: string; v: string }>) => {
    setRows(next);
    const obj = Object.fromEntries(next.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
    onChange(Object.keys(obj).length ? obj : undefined);
  };

  return (
    <div className="grid gap-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-start gap-2">
          <Input id={i === 0 ? idPrefix : undefined} value={r.k} placeholder="Key" onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
          <TemplateInput value={r.v} placeholder="Value" templates={templates} onChange={(v) => commit(rows.map((x, j) => (j === i ? { ...x, v } : x)))} />
          <Button type="button" variant="ghost" size="icon" aria-label="Remove row" onClick={() => commit(rows.filter((_, j) => j !== i))}>
            <Trash2Icon className="text-muted-foreground" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setRows([...rows, { k: '', v: '' }])}>
        <PlusIcon /> Add
      </Button>
    </div>
  );
}

function ArrayEditor({ schema, value, onChange, path, templates }: { schema: JSONSchema; value: unknown; onChange: OnChange; path: string[]; templates: boolean }) {
  const items = Array.isArray(value) ? value : [];
  const itemSchema = schema.items ?? {};
  const isObject = itemSchema.type === 'object' && itemSchema.properties;
  const set = (next: unknown[]) => onChange(next.length ? next : undefined);
  const blank = () => (isObject ? defaultsOf(itemSchema) : '');

  return (
    <div className="grid gap-2">
      {items.map((item, i) => (
        <div key={i} className={cn('flex items-start gap-2', isObject && 'rounded-lg border bg-muted/20 p-3')}>
          <div className="min-w-0 flex-1">
            {isObject ? (
              <ObjectFields schema={itemSchema} value={item} onChange={(v) => set(items.map((x, j) => (j === i ? v : x)))} path={[...path, String(i)]} />
            ) : (
              <TemplateInput value={stringifyForInput(item)} templates={templates} placeholder={`Item ${i + 1}`} onChange={(v) => set(items.map((x, j) => (j === i ? coerceScalar(v, itemSchema) : x)))} />
            )}
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label="Remove item" onClick={() => set(items.filter((_, j) => j !== i))}>
            <Trash2Icon className="text-muted-foreground" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => set([...items, blank()])} disabled={schema.maxItems !== undefined && items.length >= schema.maxItems}>
        <PlusIcon /> Add {isObject ? 'condition' : 'item'}
      </Button>
    </div>
  );
}

function coerceScalar(raw: string, schema: JSONSchema): unknown {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('number') || types.includes('integer')) {
    const n = coerceNumber(raw);
    if (typeof n === 'number' || !types.includes('string')) return n;
  }
  return raw;
}

/** Initial value for a new object item: schema defaults (and first enum value for required enums). */
export function defaultsOf(schema: JSONSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    if (s.default !== undefined) out[k] = s.default;
    else if (s.enum && schema.required?.includes(k)) out[k] = s.enum[0];
  }
  return out;
}

export function humanize(key: string): string {
  const s = key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** "minutes" → "Minutes", "not_equals" → "Not equals"; leave "POST", "MarkdownV2", "UTC" as-is. */
export function enumLabel(v: string): string {
  return /^[a-z][a-z0-9_]*$/.test(v) ? humanize(v) : v;
}
