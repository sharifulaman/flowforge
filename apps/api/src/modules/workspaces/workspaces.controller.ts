import { Controller, Get, UseGuards } from '@nestjs/common';
import { AllowApiKey, CurrentPrincipal, CurrentWorkspace } from '../../common/decorators';
import { ApiException } from '../../common/api-exception';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import type { Principal, WorkspaceContext } from '../../types/principal';
import { type WorkspaceSummary, WorkspacesService } from './workspaces.service';

/**
 * Phase (a): read endpoints used by the app shell. Full CRUD + members arrive in phase (b).
 */
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<WorkspaceSummary[]> {
    if (principal.type !== 'user') throw ApiException.forbidden();
    return this.workspaces.listForUser(principal.userId);
  }

  @Get(':workspaceId')
  @AllowApiKey()
  @UseGuards(WorkspaceGuard)
  get(@CurrentWorkspace() ws: WorkspaceContext): Promise<WorkspaceSummary> {
    return this.workspaces.get(ws.id, ws.role);
  }
}
