import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export default function setup(): void {
  const url = process.env.TEST_WORKER_DATABASE_URL ?? 'postgresql://flowforge:flowforge@localhost:5432/flowforge_test_worker?schema=public';
  execSync('pnpm exec prisma migrate deploy', { cwd: resolve(__dirname, '../../../packages/db'), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
