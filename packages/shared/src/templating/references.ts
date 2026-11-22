import { hasTemplate, parseTemplate, TemplateSyntaxError, type PathSegment } from './parser';
import { FILTERS } from './filters';

export interface TemplateReference {
  /** Root of the path, e.g. "trigger" or "step2". */
  stepKey: string;
  path: PathSegment[];
  source: string;
  /** Location of the string inside the config, e.g. "body.items.0". */
  location: string;
}

export interface TemplateIssue {
  location: string;
  message: string;
}

export interface TemplateAnalysis {
  references: TemplateReference[];
  issues: TemplateIssue[];
}

/** Walk a config, collecting references and syntax/filter errors without evaluating anything. */
export function analyzeTemplates(input: unknown): TemplateAnalysis {
  const references: TemplateReference[] = [];
  const issues: TemplateIssue[] = [];

  const walk = (v: unknown, loc: string[]) => {
    if (typeof v === 'string') {
      if (!hasTemplate(v)) return;
      const location = loc.join('.');
      try {
        for (const part of parseTemplate(v)) {
          if (part.type !== 'expr') continue;
          for (const f of part.expr.filters) {
            if (!FILTERS[f.name]) issues.push({ location, message: `Unknown filter "${f.name}"` });
          }
          references.push({
            stepKey: String(part.expr.path[0]),
            path: part.expr.path.slice(1),
            source: part.expr.source,
            location,
          });
        }
      } catch (err) {
        if (err instanceof TemplateSyntaxError) issues.push({ location, message: err.message });
        else throw err;
      }
      return;
    }
    if (Array.isArray(v)) v.forEach((item, i) => walk(item, [...loc, String(i)]));
    else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) walk(val, [...loc, k]);
  };

  walk(input, []);
  return { references, issues };
}

/** True if any string inside `value` contains a template expression. */
export function containsTemplate(value: unknown): boolean {
  if (typeof value === 'string') return hasTemplate(value);
  if (Array.isArray(value)) return value.some(containsTemplate);
  if (value && typeof value === 'object') return Object.values(value).some(containsTemplate);
  return false;
}
