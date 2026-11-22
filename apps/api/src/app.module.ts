import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard } from './common/app-throttler.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuthGuard } from './common/guards/auth.guard';
import { RedisThrottlerStorage } from './common/redis-throttler.storage';
import { ConfigModule } from './config/config.module';
import type { ApiEnv } from './config/env';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { AppsModule } from './modules/apps/apps.module';
import { ConnectionsModule } from './modules/connections/connections.module';
import { HooksModule } from './modules/hooks/hooks.module';
import { MembersModule } from './modules/members/members.module';
import { RunsModule } from './modules/runs/runs.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { ZapsModule } from './modules/zaps/zaps.module';
import { RuntimeModule } from './runtime/runtime.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

@Module({})
export class AppModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        PrismaModule,
        RedisModule,
        ThrottlerModule.forRootAsync({
          inject: [RedisThrottlerStorage],
          useFactory: (storage: RedisThrottlerStorage) => ({
            // Default budget per client IP; stricter limits are set per route with @Throttle.
            throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
            storage,
          }),
        }),
        RuntimeModule,
        ApiKeysModule,
        AuthModule,
        WorkspacesModule,
        MembersModule,
        AppsModule,
        ConnectionsModule,
        ZapsModule,
        RunsModule,
        HooksModule,
        HealthModule,
      ],
      providers: [
        // Order matters: rate-limit first (cheap), then authenticate.
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
