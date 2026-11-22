process.env.DATABASE_URL =
  process.env.TEST_ENGINE_DATABASE_URL ?? 'postgresql://flowforge:flowforge@localhost:5432/flowforge_test_engine?schema=public';
process.env.REDIS_URL = process.env.TEST_ENGINE_REDIS_URL ?? 'redis://localhost:6379/14';
