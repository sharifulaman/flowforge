import { describe, expect, it } from 'vitest';
import { hasRole } from '../src/common/guards/workspace.guard';
import { safeReturnTo } from '../src/modules/auth/auth.controller';
import { slugify } from '../src/modules/workspaces/workspaces.service';

describe('hasRole', () => {
  it('ranks OWNER > ADMIN > MEMBER', () => {
    expect(hasRole('OWNER', ['ADMIN'])).toBe(true);
    expect(hasRole('ADMIN', ['ADMIN'])).toBe(true);
    expect(hasRole('MEMBER', ['ADMIN'])).toBe(false);
    expect(hasRole('MEMBER', [])).toBe(true);
    expect(hasRole('ADMIN', ['OWNER'])).toBe(false);
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/w/1/zaps', '/w/1/zaps'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['https://evil.com', '/'],
    [undefined, '/'],
    [42, '/'],
  ])('%s → %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});

describe('slugify', () => {
  it('produces url-safe slugs with a random suffix', () => {
    expect(slugify("Zoë's Workspace!")).toMatch(/^zoe-s-workspace-[0-9a-f]{6}$/);
    expect(slugify('!!!')).toMatch(/^workspace-[0-9a-f]{6}$/);
    expect(slugify('a')).not.toBe(slugify('a'));
  });
});
