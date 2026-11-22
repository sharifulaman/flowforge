/**
 * Dev seed: creates a demo user (demo@flowforge.dev / password123) with a workspace.
 * Password hashing lives in the API; to keep this package dependency-free we import argon2 lazily.
 */
import { getPrisma } from './index';

async function main() {
  const prisma = getPrisma();
  const email = 'demo@flowforge.dev';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Seed: ${email} already exists, skipping.`);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const argon2 = require('argon2') as { hash(p: string, o: object): Promise<string> };
  const passwordHash = await argon2.hash('password123', { type: 2 });
  const user = await prisma.user.create({
    data: {
      email,
      name: 'Demo User',
      passwordHash,
      memberships: {
        create: {
          role: 'OWNER',
          workspace: { create: { name: 'Demo Workspace', slug: `demo-${Date.now().toString(36)}` } },
        },
      },
    },
  });
  console.log(`Seed: created ${user.email} (password: password123)`);
}

main()
  .then(() => getPrisma().$disconnect())
  .catch(async (err) => {
    console.error(err);
    await getPrisma().$disconnect();
    process.exit(1);
  });
