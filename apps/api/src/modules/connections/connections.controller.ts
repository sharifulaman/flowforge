import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { type ConnectionDto, type CreateConnectionInput, createConnectionSchema, type UpdateConnectionInput, updateConnectionSchema } from '@flowforge/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiException } from '../../common/api-exception';
import { AllowApiKey, CurrentPrincipal, CurrentUserId, CurrentWorkspace, Public } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import type { Principal, WorkspaceContext } from '../../types/principal';
import { ConnectionsService } from './connections.service';
import { safeReturnTo } from '../auth/auth.controller';
import { OAuthService } from './oauth.service';

@Controller('workspaces/:workspaceId/connections')
@AllowApiKey()
@UseGuards(WorkspaceGuard)
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly oauth: OAuthService,
  ) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext, @Query('appKey') appKey?: string): Promise<ConnectionDto[]> {
    return this.connections.list(ws.id, typeof appKey === 'string' ? appKey : undefined);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body(new ZodPipe(createConnectionSchema)) body: CreateConnectionInput,
  ): Promise<ConnectionDto> {
    return this.connections.create(ws.id, userId, body);
  }

  /**
   * Begin OAuth: browser navigates here; we redirect to the provider.
   * `?connectionId=` reconnects an existing connection instead of creating one.
   */
  @Get('oauth/:appKey/start')
  async oauthStart(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentPrincipal() principal: Principal,
    @Param('appKey') appKey: string,
    @Query('name') name: unknown,
    @Query('connectionId') connectionId: unknown,
    @Query('returnTo') returnTo: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (principal.type !== 'user') throw ApiException.forbidden('OAuth connections must be created by a signed-in user');
    const url = await this.oauth.start({
      workspaceId: ws.id,
      userId: principal.userId,
      appKey,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : undefined,
      connectionId: typeof connectionId === 'string' && connectionId ? connectionId : undefined,
      returnTo: typeof returnTo === 'string' && safeReturnTo(returnTo) !== '/' ? safeReturnTo(returnTo) : undefined,
    });
    return void reply.redirect(url, 302);
  }

  @Get(':connectionId')
  get(@CurrentWorkspace() ws: WorkspaceContext, @Param('connectionId') id: string): Promise<ConnectionDto> {
    return this.connections.get(ws.id, id);
  }

  @Patch(':connectionId')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('connectionId') id: string,
    @Body(new ZodPipe(updateConnectionSchema)) body: UpdateConnectionInput,
  ): Promise<ConnectionDto> {
    return this.connections.update(ws.id, id, body);
  }

  @Delete(':connectionId')
  @HttpCode(204)
  remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('connectionId') id: string): Promise<void> {
    return this.connections.delete(ws.id, id);
  }

  @Post(':connectionId/test')
  @HttpCode(200)
  test(@CurrentWorkspace() ws: WorkspaceContext, @Param('connectionId') id: string): Promise<ConnectionDto> {
    return this.connections.test(ws.id, id);
  }
}

/** Provider redirect target. Bound to the session that started the flow. */
@Controller('connections/oauth')
export class OAuthCallbackController {
  constructor(private readonly oauth: OAuthService) {}

  @Public()
  @Get('callback')
  async callback(
    @Query('state') state: unknown,
    @Query('code') code: unknown,
    @Query('error') error: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const target = await this.oauth.callback({
      userId: req.auth?.type === 'user' ? req.auth.userId : null,
      state: str(state),
      code: str(code),
      error: str(error),
    });
    return void reply.redirect(target, 302);
  }
}
