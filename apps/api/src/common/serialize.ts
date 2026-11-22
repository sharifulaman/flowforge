/** Date → ISO string, preserving null. */
export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Cursor pagination helper: fetch `limit + 1` rows, return items + next cursor. */
export function paginate<T extends { id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}
