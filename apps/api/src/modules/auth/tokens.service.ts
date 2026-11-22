import { Inject, Injectable } from '@nestjs/common';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from '@flowforge/shared';
import { randomToken, sha256Hex } from '@flowforge/shared/node';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { API_ENV, type ApiEnv } from '../../config/env';
import { ApiException } from '../../common/api-exception';
import { PrismaService } from '../../prisma/prisma.service';

const ISSUER = 'flowforge';
const ACCESS_AUDIENCE = 'flowforge:access';
const STATE_AUDIENCE = 'flowforge:oauth-state';

/**
 * A refresh token presented again within this window after rotation is treated as a benign
 * race (two tabs refreshing at once — both share the cookie jar, so the loser simply retries
 * with the new cookie). Outside the window, reuse means the token leaked: revoke the family.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface IssuedTokens {
  userId: string;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class TokensService {
  private readonly key: Uint8Array;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    private readonly prisma: PrismaService,
  ) {
    this.key = new TextEncoder().encode(env.JWT_SECRET);
  }

  // ─── Access tokens ───────────────────────────────────────────

  signAccess(userId: string, sessionId: string): Promise<string> {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  /** Returns null for any invalid/expired token (caller decides on 401). */
  async verifyAccess(token: string): Promise<{ userId: string; sessionId: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: ACCESS_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
      return { userId: payload.sub, sessionId: payload.sid };
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) return null;
      throw err;
    }
  }

  /** A session is valid if it exists, belongs to the user, is not revoked and not expired. */
  async isSessionActive(sessionId: string, userId: string): Promise<boolean> {
    const s = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true, revokedAt: true, expiresAt: true },
    });
    return !!s && s.userId === userId && !s.revokedAt && s.expiresAt > new Date();
  }

  // ─── Sessions / refresh tokens ───────────────────────────────

  async createSession(userId: string, meta: SessionMeta, familyId: string = randomUUID()): Promise<IssuedTokens> {
    const refreshToken = randomToken(32);
    const session = await this.prisma.session.create({
      data: {
        userId,
        familyId,
        refreshTokenHash: sha256Hex(refreshToken),
        userAgent: meta.userAgent?.slice(0, 512),
        ip: meta.ip,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    });
    return {
      userId,
      sessionId: session.id,
      accessToken: await this.signAccess(userId, session.id),
      refreshToken,
    };
  }

  /** Rotate a refresh token: revoke the presented session and issue a new one in the same family. */
  async rotate(refreshToken: string, meta: SessionMeta): Promise<IssuedTokens> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: sha256Hex(refreshToken) },
    });
    if (!session) throw ApiException.unauthenticated('Invalid refresh token');

    if (session.revokedAt) {
      if (Date.now() - session.revokedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
        await this.revokeFamily(session.familyId);
      }
      throw ApiException.unauthenticated('Refresh token is no longer valid');
    }
    if (session.expiresAt <= new Date()) {
      throw ApiException.unauthenticated('Session expired');
    }

    // Atomic compare-and-set: only one concurrent rotation can win.
    const { count } = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw ApiException.unauthenticated('Refresh token is no longer valid');

    return this.createSession(session.userId, meta, session.familyId);
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: sha256Hex(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ─── Signed short-lived state (OAuth) ────────────────────────

  signState(payload: Record<string, string>, ttlSeconds = 600): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(STATE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.key);
  }

  async verifyState(token: string): Promise<Record<string, unknown> | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: STATE_AUDIENCE,
        algorithms: ['HS256'],
      });
      return payload as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
