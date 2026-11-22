import type { StepTester } from '@flowforge/engine';
import type { TestStepJobData, TestStepResult } from '@flowforge/shared';
import type { Job } from 'bullmq';

export function createTestStepProcessor(tester: StepTester) {
  return (job: Job<TestStepJobData>): Promise<TestStepResult> => tester.test(job.data);
}
