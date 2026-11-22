// Runs in every test worker before any test file imports app code.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://flowforge:flowforge@localhost:5432/flowforge_test?schema=public';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.WEB_URL = 'http://localhost:3000';
process.env.COOKIE_SECURE = 'false';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
