import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  type ListRunsQuery,
  listRunsQuerySchema,
  type Paginated,
  type ReplayRunInput,
  replayRunSchema,
  type RunDetailDto,
  type RunSummaryDto,
} from '@flowforge/shared';
import { AllowApiKey, CurrentWorkspace } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import type { WorkspaceContext } from '../../types/principal';
import { RunsService } from './runs.service';

@Controller('workspaces/:workspaceId/runs')
@AllowApiKey()
@UseGuards(WorkspaceGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(listRunsQuerySchema)) q: ListRunsQuery): Promise<Paginated<RunSummaryDto>> {
    return this.runs.list(ws.id, q);
  }

  @Get(':runId')
  get(@CurrentWorkspace() ws: WorkspaceContext, @Param('runId') runId: string): Promise<RunDetailDto> {
    return this.runs.detail(ws.id, runId);
  }

  @Post(':runId/replay')
  @HttpCode(202)
  replay(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('runId') runId: string,
    @Body(new ZodPipe(replayRunSchema)) body: ReplayRunInput,
  ): Promise<{ runId: string }> {
    return this.runs.replay(ws.id, runId, body);
  }

  @Post(':runId/cancel')
  @HttpCode(200)
  cancel(@CurrentWorkspace() ws: WorkspaceContext, @Param('runId') runId: string): Promise<RunSummaryDto> {
    return this.runs.cancel(ws.id, runId);
  }
}
