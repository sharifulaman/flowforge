import { containsTemplate } from '@flowforge/shared';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { JSONSchema, ObjectSchema } from './schema';

export interface SchemaIssue {
  /** Dotted path to the field ("" for the root). */
  field: string;
  message: string;
}

const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: false, strict: false });
addFormats(ajv);
ajv.addKeyword({ keyword: 'x-ui' });
ajv.addKeyword({ keyword: 'x-enumLabels' });

const cache = new WeakMap<object, ValidateFunction>();

function compile(schema: JSONSchema): ValidateFunction {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(schema, fn);
  }
  return fn;
}

/** Throws if the schema itself is invalid (used by defineApp). */
export function assertValidSchema(schema: JSONSchema, where: string): void {
  try {
    compile(schema);
  } catch (err) {
    throw new Error(`Invalid input schema for ${where}: ${(err as Error).message}`);
  }
}

function toIssues(errors: ErrorObject[] | null | undefined): SchemaIssue[] {
  return (errors ?? []).map((e) => {
    const base = e.instancePath.replace(/^\//, '').replace(/\//g, '.');
    if (e.keyword === 'required') {
      const prop = (e.params as { missingProperty: string }).missingProperty;
      return { field: base ? `${base}.${prop}` : prop, message: 'This field is required' };
    }
    if (e.keyword === 'additionalProperties') {
      const prop = (e.params as { additionalProperty: string }).additionalProperty;
      return { field: base ? `${base}.${prop}` : prop, message: 'Unknown field' };
    }
    return { field: base, message: e.message ?? 'Invalid value' };
  });
}

/**
 * Validate fully-resolved data (runtime). Applies schema defaults to a copy.
 * Returns the defaulted value when valid.
 */
export function validateInput<T = Record<string, unknown>>(
  schema: ObjectSchema,
  value: unknown,
): { ok: true; value: T } | { ok: false; issues: SchemaIssue[] } {
  const copy = structuredClone(value ?? {});
  const validate = compile(schema);
  if (validate(copy)) return { ok: true, value: copy as T };
  return { ok: false, issues: toIssues(validate.errors) };
}

/** Empty for the purposes of "required": undefined, null, "" or whitespace. */
function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Validate a draft step config at publish time. Values containing `{{ templates }}` can't be
 * type-checked until runtime, so they are accepted for any type, but `required` still applies.
 */
export function validateConfig(schema: ObjectSchema, config: Record<string, unknown>): SchemaIssue[] {
  const [prunedSchema, prunedConfig] = prune(schema, config ?? {});
  const issues: SchemaIssue[] = [];
  // Blank strings don't satisfy "required" in a form.
  for (const key of schema.required ?? []) {
    if (isBlank(config?.[key])) issues.push({ field: key, message: 'This field is required' });
  }
  const validate = compile(prunedSchema);
  if (!validate(structuredClone(prunedConfig))) {
    for (const issue of toIssues(validate.errors)) {
      if (!issues.some((i) => i.field === issue.field)) issues.push(issue);
    }
  }
  return issues;
}

/** Remove templated values (and their "required"/type constraints) recursively. */
function prune(schema: JSONSchema, value: Record<string, unknown>): [JSONSchema, Record<string, unknown>] {
  const outSchema: JSONSchema = { ...schema, properties: { ...schema.properties } };
  const outValue: Record<string, unknown> = {};
  const templated = new Set<string>();

  for (const [k, v] of Object.entries(value)) {
    const propSchema = schema.properties?.[k];
    if (typeof v === 'string' && containsTemplate(v)) {
      // Only declared fields are exempt; unknown keys must still fail additionalProperties.
      if (propSchema) {
        templated.add(k);
        continue;
      }
    }
    if (propSchema?.type === 'object' && propSchema.properties && v && typeof v === 'object' && !Array.isArray(v)) {
      const [s, val] = prune(propSchema, v as Record<string, unknown>);
      outSchema.properties![k] = s;
      outValue[k] = val;
      continue;
    }
    if (propSchema && containsTemplate(v)) {
      // Arrays / free-form objects with templates inside: only check the container type.
      outSchema.properties![k] = { type: propSchema.type };
    }
    outValue[k] = v;
  }
  for (const k of templated) delete outSchema.properties![k];
  outSchema.required = (schema.required ?? []).filter((r) => !templated.has(r));
  return [outSchema, outValue];
}
