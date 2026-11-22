import { Body, Controller, Delete, Get, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import {
  type CreateWorkspaceInput,
  createWorkspaceSchema,
  type UpdateWorkspaceInput,
  updateWorkspaceSchema,
} from '@flowforge/shared';
import { ApiException } from '../../common/api-exception';
import { AllowApiKey, CurrentPrincipal, CurrentWorkspace, Roles } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import type { Principal, WorkspaceContext } from '../../types/principal';
import { type WorkspaceSummary, WorkspacesService } from './workspaces.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<WorkspaceSummary[]> {
    if (principal.type !== 'user') throw ApiException.forbidden();
    return this.workspaces.listForUser(principal.userId);
  }

  @Post()
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(createWorkspaceSchema)) body: CreateWorkspaceInput,
  ): Promise<WorkspaceSummary> {
    if (principal.type !== 'user') throw ApiException.forbidden();
    return this.workspaces.create(principal.userId, body);
  }

  @Get(':workspaceId')
  @AllowApiKey()
  @UseGuards(WorkspaceGuard)
  get(@CurrentWorkspace() ws: WorkspaceContext): Promise<WorkspaceSummary> {
    return this.workspaces.get(ws.id, ws.role);
  }

  @Patch(':workspaceId')
  @Roles('ADMIN')
  @UseGuards(WorkspaceGuard)
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(updateWorkspaceSchema)) body: UpdateWorkspaceInput,
  ): Promise<WorkspaceSummary> {
    return this.workspaces.update(ws.id, ws.role, body);
  }

  @Delete(':workspaceId')
  @HttpCode(204)
  @Roles('OWNER')
  @UseGuards(WorkspaceGuard)
  async remove(@CurrentWorkspace() ws: WorkspaceContext, @CurrentPrincipal() principal: Principal): Promise<void> {
    if (principal.type !== 'user') throw ApiException.forbidden('API keys cannot delete workspaces');
    await this.workspaces.delete(ws.id);
  }
}
