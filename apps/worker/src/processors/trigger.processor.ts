import type { TriggerRuntime } from '@flowforge/engine';
import type { TriggerJobData } from '@flowforge/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

/** BullMQ job-scheduler job ids end with the scheduled timestamp: `repeat:<key>:<millis>`. */
export function scheduledTimeOf(job: Pick<Job, 'id' | 'timestamp'>): Date {
  const millis = Number(String(job.id ?? '').split(':').pop());
  return new Date(Number.isFinite(millis) && millis > 0 ? millis : job.timestamp);
}

export function createTriggerProcessor(runtime: TriggerRuntime, logger: Logger) {
  return async (job: Job<TriggerJobData>) => {
    const log = logger.child({ zapId: job.data.zapId, kind: job.data.kind });
    if (job.data.kind === 'schedule') {
      const res = await runtime.fireSchedule(job.data, job.id ?? `${job.data.zapId}:${job.timestamp}`, scheduledTimeOf(job));
      log.debug(res, 'schedule fired');
      return res;
    }
    const res = await runtime.poll(job.data);
    if (res.launched.length) log.info({ launched: res.launched.length }, 'poll found new items');
    return res;
  };
}
