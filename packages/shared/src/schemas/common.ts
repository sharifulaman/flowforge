import { z } from 'zod';

/** Prisma cuid() ids. Loose check (length/charset) to reject garbage early. */
export const idSchema = z
  .string()
  .min(20)
  .max(32)
  .regex(/^[a-z0-9]+$/i, 'Invalid id');

export const paginationQuerySchema = z.object({
  cursor: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
