import { Injectable } from '@nestjs/common';
import { Prisma } from '@flowforge/db';
import type { LoginInput, MeResponse, RegisterInput } from '@flowforge/shared';
import { ApiException } from '../../common/api-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import type { GoogleProfile } from './google-oauth.client';
import { PasswordService } from './password.service';
import { type IssuedTokens, type SessionMeta, TokensService } from './tokens.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokensService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async register(input: RegisterInput, meta: SessionMeta): Promise<IssuedTokens> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (existing) throw ApiException.conflict('An account with this email already exists');

    const passwordHash = await this.passwords.hash(input.password);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email: input.email, name: input.name, passwordHash },
        });
        await this.workspaces.createPersonal(tx, created.id, input.name);
        return created;
      });
      return this.tokens.createSession(user.id, meta);
    } catch (err) {
      // Lost a race with a concurrent registration for the same email.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw ApiException.conflict('An account with this email already exists');
      }
      throw err;
    }
  }

  async login(input: LoginInput, meta: SessionMeta): Promise<IssuedTokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, passwordHash: true },
    });
    // verify() runs against a dummy hash when the user is missing → uniform timing.
    const ok = await this.passwords.verify(user?.passwordHash, input.password);
    if (!user || !ok) throw ApiException.unauthenticated('Invalid email or password');

    if (user.passwordHash && this.passwords.needsRehash(user.passwordHash)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await this.passwords.hash(input.password) },
      });
    }
    return this.tokens.createSession(user.id, meta);
  }

  /**
   * Sign in with Google:
   *  1. Known Google account → that user.
   *  2. Verified email matching an existing user → link the Google account to it.
   *  3. Otherwise create a user (+ personal workspace).
   */
  async loginWithGoogle(profile: GoogleProfile, meta: SessionMeta): Promise<IssuedTokens> {
    if (!profile.emailVerified) {
      throw ApiException.forbidden('Your Google email address is not verified');
    }
    const userId = await this.prisma.$transaction(async (tx) => {
      const account = await tx.oAuthAccount.findUnique({
        where: { provider_providerAccountId: { provider: 'google', providerAccountId: profile.sub } },
        select: { userId: true },
      });
      if (account) return account.userId;

      const byEmail = await tx.user.findUnique({ where: { email: profile.email } });
      if (byEmail) {
        await tx.oAuthAccount.create({
          data: { provider: 'google', providerAccountId: profile.sub, userId: byEmail.id },
        });
        await tx.user.update({
          where: { id: byEmail.id },
          data: {
            emailVerified: byEmail.emailVerified ?? new Date(),
            avatarUrl: byEmail.avatarUrl ?? profile.picture,
            name: byEmail.name ?? profile.name,
          },
        });
        return byEmail.id;
      }

      const name = profile.name?.trim() || profile.email.split('@')[0]!;
      const created = await tx.user.create({
        data: {
          email: profile.email,
          name,
          avatarUrl: profile.picture,
          emailVerified: new Date(),
          accounts: { create: { provider: 'google', providerAccountId: profile.sub } },
        },
      });
      await this.workspaces.createPersonal(tx, created.id, name);
      return created.id;
    });
    return this.tokens.createSession(userId, meta);
  }

  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: { workspace: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!user) throw ApiException.unauthenticated();
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        hasPassword: user.passwordHash !== null,
        createdAt: user.createdAt.toISOString(),
      },
      workspaces: user.memberships.map((m) => ({ ...m.workspace, role: m.role })),
    };
  }
}
