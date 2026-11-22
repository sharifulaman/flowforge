import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { type ApiKeyDto, type CreateApiKeyInput, createApiKeySchema } from '@flowforge/shared';
import { ApiException } from '../../common/api-exception';
import { CurrentPrincipal, CurrentWorkspace, Roles } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import type { Principal, WorkspaceContext } from '../../types/principal';
import { ApiKeysService } from './api-keys.service';

/** Session-only: an API key cannot mint or revoke API keys. */
@Controller('workspaces/:workspaceId/api-keys')
@UseGuards(WorkspaceGuard)
@Roles('ADMIN')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext): Promise<ApiKeyDto[]> {
    return this.keys.list(ws.id);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(createApiKeySchema)) body: CreateApiKeyInput,
  ): Promise<ApiKeyDto & { key: string }> {
    if (principal.type !== 'user') throw ApiException.forbidden();
    return this.keys.create(ws.id, principal.userId, body);
  }

  @Delete(':keyId')
  @HttpCode(204)
  revoke(@CurrentWorkspace() ws: WorkspaceContext, @Param('keyId') keyId: string): Promise<void> {
    return this.keys.revoke(ws.id, keyId);
  }
}
