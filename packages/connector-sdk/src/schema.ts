/** UI hints for the dynamic form renderer (ignored by validation). */
export interface FieldUi {
  widget?: 'text' | 'textarea' | 'code' | 'password' | 'select' | 'json' | 'keyvalue' | 'cron' | 'toggle' | 'number';
  placeholder?: string;
  /** Short help text rendered under the field. Markdown links allowed. */
  help?: string;
  /** Name of an `optionLoaders` entry that returns `{ label, value }[]` for a select. */
  dynamicOptions?: string;
  /** Other field names this field's options depend on (reload when they change). */
  dependsOn?: string[];
  /** Code language for widget "code". */
  language?: 'javascript' | 'json';
  /** Hide the field-picker ("insert data") button for this field. */
  noTemplates?: boolean;
  /** Render in a collapsed "Advanced" section. */
  advanced?: boolean;
}

/** The subset of JSON Schema (draft 2020-12) FlowForge forms understand, plus `x-ui`. */
export interface JSONSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null' | Array<'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'>;
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
  items?: JSONSchema;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  'x-ui'?: FieldUi;
  'x-enumLabels'?: string[];
}

export interface ObjectSchema extends JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchema>;
}

/** Convenience constructor that keeps literal typing. */
export function objectSchema(properties: Record<string, JSONSchema>, required: string[] = []): ObjectSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}
