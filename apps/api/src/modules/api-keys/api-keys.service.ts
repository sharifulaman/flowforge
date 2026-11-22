import { Injectable } from '@nestjs/common';
import type { ApiKey } from '@flowforge/db';
import { API_KEY_PREFIX, type ApiKeyDto, type CreateApiKeyInput } from '@flowforge/shared';
import { randomToken, sha256Hex } from '@flowforge/shared/node';
import { ApiException } from '../../common/api-exception';
import { iso } from '../../common/serialize';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_ACTIVE_KEYS = 25;

function toDto(k: ApiKey): ApiKeyDto {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    createdAt: iso(k.createdAt)!,
    lastUsedAt: iso(k.lastUsedAt),
    expiresAt: iso(k.expiresAt),
    revokedAt: iso(k.revokedAt),
  };
}

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string): Promise<ApiKeyDto[]> {
    const keys = await this.prisma.apiKey.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
    return keys.map(toDto);
  }

  /** The plaintext key is returned exactly once; only its SHA-256 is stored. */
  async create(workspaceId: string, userId: string, input: CreateApiKeyInput): Promise<ApiKeyDto & { key: string }> {
    const active = await this.prisma.apiKey.count({ where: { workspaceId, revokedAt: null } });
    if (active >= MAX_ACTIVE_KEYS) throw ApiException.badRequest(`A workspace can have at most ${MAX_ACTIVE_KEYS} active API keys`);

    const key = `${API_KEY_PREFIX}${randomToken(32)}`;
    const row = await this.prisma.apiKey.create({
      data: {
        workspaceId,
        createdById: userId,
        name: input.name,
        prefix: key.slice(0, API_KEY_PREFIX.length + 6),
        keyHash: sha256Hex(key),
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      },
    });
    return { ...toDto(row), key };
  }

  async revoke(workspaceId: string, keyId: string): Promise<void> {
    const { count } = await this.prisma.apiKey.updateMany({
      where: { id: keyId, workspaceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      const exists = await this.prisma.apiKey.findFirst({ where: { id: keyId, workspaceId }, select: { id: true } });
      if (!exists) throw ApiException.notFound('API key');
    }
  }
}
