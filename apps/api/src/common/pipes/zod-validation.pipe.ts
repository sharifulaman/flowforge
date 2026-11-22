import { type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiException } from '../api-exception';

/**
 * Validates and transforms input with a zod schema.
 * Usage: `@Body(new ZodPipe(createZapSchema)) body: CreateZapInput`
 */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw ApiException.validation(
        result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      );
    }
    return result.data;
  }
}
