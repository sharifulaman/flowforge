import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit key: client IP for the API, the hook token for public webhooks (so one noisy
 * integration can't exhaust the budget of everyone behind the same NAT, and vice versa).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const url: string = req.url ?? '';
    if (url.startsWith('/hooks/')) {
      const token = url.split('?')[0]!.split('/').filter(Boolean).pop();
      if (token) return `hook:${token}`;
    }
    return req.ip;
  }
}
