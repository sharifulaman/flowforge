import { Injectable } from '@nestjs/common';
import { API_KEY_PREFIX } from '@flowforge/shared';
import { sha256Hex } from '@flowforge/shared/node';
import { PrismaService } from '../../prisma/prisma.service';
import type { Principal } from '../../types/principal';

/** Don't write lastUsedAt more than once per minute per key. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

@Injectable()
export class ApiKeyAuthService {
  constructor(private readonly prisma: PrismaService) {}

  looksLikeApiKey(token: string): boolean {
    return token.startsWith(API_KEY_PREFIX) && token.length > API_KEY_PREFIX.length + 20;
  }

  /** Resolve a raw API key to a principal, or null if unknown/revoked/expired. */
  async authenticate(rawKey: string): Promise<Extract<Principal, { type: 'apiKey' }> | null> {
    if (!this.looksLikeApiKey(rawKey)) return null;
    const key = await this.prisma.apiKey.findUnique({ where: { keyHash: sha256Hex(rawKey) } });
    if (!key || key.revokedAt) return null;
    if (key.expiresAt && key.expiresAt <= new Date()) return null;

    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
      // Fire-and-forget; auth must not fail because of bookkeeping.
      void this.prisma.apiKey
        .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }
    return { type: 'apiKey', apiKeyId: key.id, workspaceId: key.workspaceId, actingUserId: key.createdById };
  }
}
