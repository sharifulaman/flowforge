import { describe, expect, it } from 'vitest';
import { loginSchema, registerSchema } from '../src';

describe('auth schemas', () => {
  it('normalizes email', () => {
    const r = registerSchema.parse({ email: '  Alice@Example.COM ', password: 'longenough', name: ' Alice ' });
    expect(r.email).toBe('alice@example.com');
    expect(r.name).toBe('Alice');
  });

  it('rejects short passwords and bad emails', () => {
    const r = registerSchema.safeParse({ email: 'nope', password: 'short', name: 'x' });
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('login requires a password', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });
});
