import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { ConnectorRegistry } from '@flowforge/connector-sdk';
import {
  type AddStepInput,
  addStepSchema,
  type CreateZapInput,
  createZapSchema,
  type ListZapsQuery,
  listZapsQuerySchema,
  type ManualRunInput,
  manualRunSchema,
  type Paginated,
  type ReorderStepsInput,
  reorderStepsSchema,
  type SetTriggerInput,
  type TestStepResult,
  setTriggerSchema,
  type UpdateStepInput,
  updateStepSchema,
  type UpdateZapInput,
  updateZapSchema,
  type ZapDetailDto,
  type ZapSummaryDto,
  type ZapVersionDto,
} from '@flowforge/shared';
import { AllowApiKey, CurrentUserId, CurrentWorkspace } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CONNECTOR_REGISTRY } from '../../runtime/tokens';
import type { WorkspaceContext } from '../../types/principal';
import { ZapLifecycleService } from './lifecycle.service';
import { StepTestService } from './step-test.service';
import { StepsService } from './steps.service';
import { sortedSteps } from './zap-mapper';
import { ZapsService } from './zaps.service';

export interface StepSampleDto {
  key: string;
  name: string | null;
  type: 'TRIGGER' | 'ACTION';
  position: number;
  appKey: string;
  operationKey: string;
  /** Real output from the last test, or the connector's example output. */
  sample: unknown;
  isExample: boolean;
}

@Controller('workspaces/:workspaceId/zaps')
@AllowApiKey()
@UseGuards(WorkspaceGuard)
export class ZapsController {
  constructor(
    private readonly zaps: ZapsService,
    private readonly steps: StepsService,
    private readonly lifecycle: ZapLifecycleService,
    private readonly stepTests: StepTestService,
    @Inject(CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
  ) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(listZapsQuerySchema)) q: ListZapsQuery): Promise<Paginated<ZapSummaryDto>> {
    return this.zaps.list(ws.id, q);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body(new ZodPipe(createZapSchema)) body: CreateZapInput,
  ): Promise<ZapDetailDto> {
    return this.zaps.create(ws.id, userId, body);
  }

  @Get(':zapId')
  get(@CurrentWorkspace() ws: WorkspaceContext, @Param('zapId') zapId: string): Promise<ZapDetailDto> {
    return this.zaps.detail(ws.id, zapId);
  }

  @Patch(':zapId')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('zapId') zapId: string,
    @Body(new ZodPipe(updateZapSchema)) body: UpdateZapInput,
  ): Promise<ZapDetailDto> {
    return this.zaps.update(ws.id, zapId, body);
  }

  @Delete(':zapId')
  @HttpCode(204)
  remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('zapId') zapId: string): Promise<void> {
    return this.zaps.delete(ws.id, zapId);
  }

  @Post(':zapId/duplicate')
  duplicate(@CurrentWorkspace() ws: WorkspaceContext, @Param('zapId') zapId: string, @CurrentUserId() userId: string): Promise<ZapDetailDto> {
    return this.zaps.duplicate(ws.id, zapId, userId);
  }

  // ─── Steps ────────────────────────────────────────────

  @Put(':zapId/trigger')
  setTrigger(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('zapId') zapId: string,
    @Body(new ZodPipe(setTriggerSchema)) body: SetTriggerInput,
  ): Promise<ZapDetailDto> {
    return this.steps.setTrigger(ws.id, zapId, body);
  }

  @Post(':zapId/steps')
  addStep(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('zapId') zapId: string,
    @Body(new ZodPipe(addStepSchema)) body: AddStepInput,
  ): Promise<ZapDetailDto> {
    return this.steps.addStep(ws.id, zapId, body);
  }

  @Post(':zapId/steps/reorder')
  @HttpCode(200)
  reorder(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('zapId') zapId: string,
    @Body(new ZodPipe(reorderStepsSchema)) body: ReorderStepsInput,
  ): Promise<ZapDetailDto> {
    return this.steps.reorder(ws.id, zapId, body);
  }

  @Patch(':zapId/steps/:stepId')
  updateStep(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('zapId') zapId: string,
    @Param('stepId') stepId: string,
    @Body(new ZodPipe(updateStepSchema)) body: UpdateStepInput,
  ): Promise<ZapDetailDto> {
    return this.steps.updateStep(ws.id, zapId, stepId, body);
  }

  @Delete(':zapId/steps/:stepId')
  deleteStep(@CurrentWorkspace() ws: WorkspaceContext, @Param('zapId') zapId: string, @Param('stepId') stepId: string): Promise<ZapDetailDto> {
    return this.steps.deleteStep(ws.id, zapId, stepId);
  }

  /** Run one draft step for real (in the worker); a successful output becomes its sample. */
  @Post(':zapId/steps/:stepId/test')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  testStep(@CurrentWorkspace() ws: WorkspaceContext, @Param('zapId') zapId: string, @Param('stepId') stepId: string): Promise<TestStepResult> {
    return this.stepTests.test(ws.id, zapId, stepId);
  }

  /** Data available to the field picker: each step's last test output (or example output). */
  @Get(':zapId/samples')
  async samples(@CurrentWorkspace() ws: WorkspaceContext, @Param('zapId') zapId: string): Promise<StepSampleDto[]> {
    const zap = await this.zaps.findOrThrow(ws.id, zapId);
    return sortedSteps(zap.steps).map((s) => {
      const op = s.type === 'TRIGGER' ? this.registry.getTrigger(s.appKey, s.operationKey) : this.registry.getAction(s.appKey, s.operationKey);
      const real = s.sampleOutput ?? null;
      return {
        key: s.key,
        name: s.name,
        type: s.type,
        position: s.position,
        appKey: s.appKey,
        operationKey: s.operationKey,
        sample: real ?? op?.sampleOutput ?? null,
        isExample: real === null,
      };
    });
  }

  // ─── Lifecycle ────────────────────────────────────────

  @Post(':zapId/enable')
  @HttpCode(200)
  enable(@CurrentWorkspace() ws: WorkspaceContext, @Param('zapId') zapId: string, @CurrentUserId() userId: string): Promise<ZapDetailDto> {
    return this.lifecycle.enable(ws.id, zapId, userId);
  }

  @Post(':zapId/disable')
  @HttpCode(200)
  disable(@CurrentWorkspace() ws: WorkspaceContext, @Param('zapId') zapId: string): Promise<ZapDetailDto> {
    return this.lifecycle.disable(ws.id, zapId);
  }

  @Get(':zapId/versions')
  versions(@CurrentWorkspace() ws: WorkspaceContext, @Param('zapId') zapId: string): Promise<ZapVersionDto[]> {
    return this.lifecycle.versions(ws.id, zapId);
  }

  @Post(':zapId/run')
  @HttpCode(202)
  run(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('zapId') zapId: string,
    @Body(new ZodPipe(manualRunSchema)) body: ManualRunInput,
  ): Promise<{ runId: string }> {
    return this.lifecycle.runNow(ws.id, zapId, body);
  }

  @Post(':zapId/trigger/rotate-token')
  @HttpCode(200)
  rotateToken(@CurrentWorkspace() ws: WorkspaceContext, @Param('zapId') zapId: string): Promise<ZapDetailDto> {
    return this.lifecycle.rotateHookToken(ws.id, zapId);
  }
}
