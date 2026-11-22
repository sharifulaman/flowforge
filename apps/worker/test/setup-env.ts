process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = process.env.TEST_WORKER_DATABASE_URL ?? 'postgresql://flowforge:flowforge@localhost:5432/flowforge_test_worker?schema=public';
process.env.REDIS_URL = process.env.TEST_WORKER_REDIS_URL ?? 'redis://localhost:6379/13';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
