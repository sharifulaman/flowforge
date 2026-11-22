import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ErrorCode, TEST_STEP_TIMEOUT_MS, type TestStepJobData, type TestStepResult } from '@flowforge/shared';
import type { Queue, QueueEvents } from 'bullmq';
import { ApiException } from '../../common/api-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { TEST_STEP_EVENTS, TEST_STEP_QUEUE } from '../../runtime/tokens';

/**
 * "Test step" runs in the worker (sandbox + outbound calls never execute in the API).
 * The request waits for the job result, bounded by TEST_STEP_TIMEOUT_MS.
 */
@Injectable()
export class StepTestService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TEST_STEP_QUEUE) private readonly queue: Queue<TestStepJobData>,
    @Inject(TEST_STEP_EVENTS) private readonly events: QueueEvents,
  ) {}

  async test(workspaceId: string, zapId: string, stepId: string): Promise<TestStepResult> {
    const step = await this.prisma.zapStep.findFirst({
      where: { id: stepId, zapId, workspaceId, zap: { deletedAt: null } },
      select: { id: true },
    });
    if (!step) throw ApiException.notFound('Step');

    const job = await this.queue.add(
      'test',
      { workspaceId, zapId, stepId },
      { removeOnComplete: { age: 300 }, removeOnFail: { age: 300 }, attempts: 1 },
    );
    try {
      return (await job.waitUntilFinished(this.events, TEST_STEP_TIMEOUT_MS)) as TestStepResult;
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (/timed out|timeout/i.test(message)) {
        await job.remove().catch(() => undefined);
        throw new ApiException(HttpStatus.GATEWAY_TIMEOUT, ErrorCode.UPSTREAM_ERROR, 'The test did not finish in time. Is the worker running?');
      }
      throw new ApiException(HttpStatus.BAD_GATEWAY, ErrorCode.UPSTREAM_ERROR, `Test failed: ${message}`);
    }
  }
}
