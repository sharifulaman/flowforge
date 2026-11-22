import { Inject, Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.constants';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Fixed-window counter with optional block period, executed atomically in Redis so limits
 * hold across multiple API replicas. Returns seconds, as @nestjs/throttler expects.
 */
const SCRIPT = `
local hitKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', hitKey) or '0')
  local hitTtl = redis.call('PTTL', hitKey)
  return { hits, math.max(hitTtl, 0), 1, blockTtl }
end

local hits = redis.call('INCR', hitKey)
if hits == 1 then
  redis.call('PEXPIRE', hitKey, ttl)
end
local hitTtl = redis.call('PTTL', hitKey)

if hits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockDuration)
  return { hits, hitTtl, 1, blockDuration }
end
return { hits, hitTtl, 0, 0 }
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `ff:throttle:${throttlerName}:${key}`;
    const result = (await this.redis.eval(
      SCRIPT,
      2,
      `${base}:hits`,
      `${base}:block`,
      ttl,
      limit,
      blockDuration > 0 ? blockDuration : ttl,
    )) as [number, number, number, number];
    const [totalHits, hitTtlMs, blocked, blockTtlMs] = result;
    return {
      totalHits,
      timeToExpire: Math.ceil(hitTtlMs / 1000),
      isBlocked: blocked === 1,
      timeToBlockExpire: Math.ceil(blockTtlMs / 1000),
    };
  }
}
