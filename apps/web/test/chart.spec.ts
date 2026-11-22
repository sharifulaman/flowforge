import { describe, expect, it } from 'vitest';
import { bucketLabel, compactNumber, delta, labelEvery, niceScale } from '@/lib/chart';

describe('niceScale', () => {
  it.each([
    [0, 4, [0, 1, 2, 3, 4]],
    [3, 4, [0, 1, 2, 3]],
    [7, 4, [0, 2, 4, 6, 8]],
    [38, 4, [0, 10, 20, 30, 40]],
    [97, 4, [0, 25, 50, 75, 100]],
    [1234, 4, [0, 500, 1000, 1500]],
  ])('max %d → %j', (max, ticks, expected) => {
    expect(niceScale(max, ticks).ticks).toEqual(expected);
  });

  it('top tick always covers the data', () => {
    for (const m of [1, 9, 11, 49, 51, 999, 10_001]) expect(niceScale(m).max).toBeGreaterThanOrEqual(m);
  });
});

describe('formatting', () => {
  it('compacts only from 10,000', () => {
    expect(compactNumber(1284)).toBe('1,284');
    expect(compactNumber(12_900)).toBe('12.9K');
    expect(compactNumber(4_200_000)).toBe('4.2M');
  });

  it('labels buckets in UTC', () => {
    expect(bucketLabel('2026-06-10T09:00:00.000Z', 'hour')).toBe('09:00');
    expect(bucketLabel('2026-06-03T00:00:00.000Z', 'day')).toBe('Jun 3');
  });

  it('thins x labels', () => {
    expect(labelEvery(24, 8)).toBe(3);
    expect(labelEvery(7, 8)).toBe(1);
  });
});

describe('delta', () => {
  it('colors by direction × whether up is good', () => {
    expect(delta(10, 5, true)).toEqual({ value: 5, direction: 'up', good: true });
    expect(delta(10, 5, false)).toEqual({ value: 5, direction: 'up', good: false });
    expect(delta(2, 5, false)).toEqual({ value: -3, direction: 'down', good: true });
    expect(delta(5, 5, true)).toEqual({ value: 0, direction: 'flat', good: null });
    expect(delta(0.9, null, true)).toBeNull();
  });
});
