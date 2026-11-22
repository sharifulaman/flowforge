import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { RedisThrottlerStorage } from '../common/redis-throttler.storage';
import { API_ENV, type ApiEnv } from '../config/env';

export { REDIS } from './redis.constants';
import { REDIS } from './redis.constants';

@Injectable()
class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) =>
        new Redis(env.REDIS_URL, {
          // Required by BullMQ for blocking connections; harmless for regular commands.
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
          lazyConnect: false,
        }),
    },
    RedisLifecycle,
    RedisThrottlerStorage,
  ],
  exports: [REDIS, RedisThrottlerStorage],
})
export class RedisModule {}
