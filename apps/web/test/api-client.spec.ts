import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/lib/api-client';
import { safeReturnTo } from '@/lib/redirect';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('parses API errors into ApiError with field errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(400, {
          error: { code: 'VALIDATION_FAILED', message: 'Validation failed', issues: [{ path: 'email', message: 'bad' }] },
        }),
      ),
    );
    const err = await api('/auth/register', { method: 'POST', body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.fieldErrors()).toEqual({ email: 'bad' });
  });

  it('refreshes once on 401 and retries; concurrent 401s share one refresh', async () => {
    let authed = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) {
        authed = true;
        return json(200, { ok: true });
      }
      return authed ? json(200, { ok: 1 }) : json(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const results = await Promise.all([api('/workspaces'), api('/auth/me')]);
    expect(results).toEqual([{ ok: 1 }, { ok: 1 }]);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('does not try to refresh for credential endpoints', async () => {
    const fetchMock = vi.fn(async () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Invalid' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await expect(api('/auth/me')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('returns undefined for 204', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});

describe('safeReturnTo', () => {
  it('only allows relative same-site paths', () => {
    expect(safeReturnTo('/w/1')).toBe('/w/1');
    expect(safeReturnTo('//evil.com')).toBeNull();
    expect(safeReturnTo('https://evil.com')).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
  });
});
