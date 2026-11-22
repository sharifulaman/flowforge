import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

/**
 * Load the nearest `.env` file (walking up from `startDir` to the monorepo root) into
 * process.env. Variables already present in the environment always win, so Docker /
 * CI configuration overrides the file.
 */
export function loadDotEnv(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      const parsed = parseEnv(readFileSync(candidate, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined && v !== undefined) process.env[k] = v;
      }
      return candidate;
    }
    const isRoot = existsSync(join(dir, 'pnpm-workspace.yaml'));
    const parent = dirname(dir);
    if (isRoot || parent === dir) return null;
    dir = parent;
  }
}

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

/** Validates a base64 string that decodes to exactly 32 bytes (AES-256 key). */
const aesKey = z
  .string()
  .min(1)
  .refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'must be base64 that decodes to exactly 32 bytes (openssl rand -base64 32)',
  });

/** Environment shared by api + worker. Apps may `.extend()` it. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  HOOKS_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  ENCRYPTION_KEY: aesKey,
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  /** Old keys for decryption during rotation: "1:<base64>,2:<base64>". */
  ENCRYPTION_KEYS_PREVIOUS: z.string().optional(),
  COOKIE_SECURE: booleanish.default(false),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Load `.env`, then validate process.env against `schema`. Throws a readable error. */
export function loadEnv<S extends z.ZodType>(schema: S, source?: NodeJS.ProcessEnv): z.infer<S> {
  if (!source) loadDotEnv();
  const result = schema.safeParse(source ?? process.env);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}
