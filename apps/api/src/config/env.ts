import { baseEnvSchema, loadEnv } from '@flowforge/shared/node';
import { z } from 'zod';

export const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  /** Comma-separated extra origins allowed for cookie-authenticated mutations. */
  ALLOWED_ORIGINS: z.string().optional().default(''),
  /**
   * Comma-separated hostnames/IPs exempt from SSRF blocking (e.g. "localhost,127.0.0.1" for
   * local development against services on your machine). Leave empty in production.
   */
  HTTP_ALLOW_PRIVATE_HOSTS: z.string().optional().default(''),
  /** Trust X-Forwarded-* headers (set when running behind a reverse proxy / the Next.js rewrite). */
  TRUST_PROXY: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1'))
    .default(true),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const API_ENV = Symbol('API_ENV');

export function loadApiEnv(source?: NodeJS.ProcessEnv): ApiEnv {
  return loadEnv(apiEnvSchema, source);
}
