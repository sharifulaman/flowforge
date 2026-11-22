import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvValidationError, baseEnvSchema, loadEnv } from '../src/node/env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(baseEnvSchema, valid as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.ENCRYPTION_KEY_VERSION).toBe(1);
  });

  it('coerces booleans', () => {
    const env = loadEnv(baseEnvSchema, { ...valid, COOKIE_SECURE: 'true' } as NodeJS.ProcessEnv);
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it('rejects a short encryption key with a readable message', () => {
    try {
      loadEnv(baseEnvSchema, { ...valid, ENCRYPTION_KEY: 'c2hvcnQ=' } as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      expect((e as Error).message).toMatch(/ENCRYPTION_KEY: must be base64/);
    }
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() => loadEnv(baseEnvSchema, { ENCRYPTION_KEY: valid.ENCRYPTION_KEY } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });
});
