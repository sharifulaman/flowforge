import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { type StatsDto, statsQuerySchema } from '@flowforge/shared';
import { AllowApiKey, CurrentWorkspace } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import type { WorkspaceContext } from '../../types/principal';
import { StatsService } from './stats.service';

@Controller('workspaces/:workspaceId/stats')
@AllowApiKey()
@UseGuards(WorkspaceGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  get(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(statsQuerySchema)) q: { range: StatsDto['range'] }): Promise<StatsDto> {
    return this.stats.get(ws.id, q.range);
  }
}
