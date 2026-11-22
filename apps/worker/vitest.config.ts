import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    pool: 'forks',
    // isolated-vm requires this flag on Node >= 20.
    poolOptions: { forks: { execArgv: ['--no-node-snapshot'] } },
  },
});
