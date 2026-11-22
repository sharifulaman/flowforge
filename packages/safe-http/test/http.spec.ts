import { AuthError, FatalError, RetryableError } from '@flowforge/connector-sdk';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSafeUrl, createSafeLookup, isPublicAddress, parseRetryAfter, SafeHttpClient, SsrfBlockedError } from '../src';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function startServer(handler: Handler): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('isPublicAddress', () => {
  it.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['2606:4700:4700::1111', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false], // cloud metadata
    ['100.64.0.1', false], // CGNAT
    ['0.0.0.0', false],
    ['255.255.255.255', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['::', false],
    ['fc00::1', false],
    ['fe80::1', false],
    ['::ffff:127.0.0.1', false], // IPv4-mapped loopback
    ['::ffff:8.8.8.8', true],
    ['64:ff9b::7f00:1', false], // NAT64 → 127.0.0.1
    ['2002:7f00:1::', false], // 6to4
    ['not-an-ip', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe('assertSafeUrl', () => {
  it.each([
    'file:///etc/passwd',
    'gopher://x',
    'ftp://example.com',
    'http://user:pass@example.com',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:8080',
    'http://api.localhost',
    'http://metadata.google.internal',
    'http://0x7f000001/', // hex IP — WHATWG URL normalizes to 127.0.0.1
    'http://2130706433/', // decimal IP
    'not a url',
  ])('blocks %s', (url) => {
    expect(() => assertSafeUrl(url)).toThrow();
  });

  it('allows public URLs and allow-listed hosts', () => {
    expect(assertSafeUrl('https://api.example.com/x').hostname).toBe('api.example.com');
    expect(assertSafeUrl('http://127.0.0.1:9/x', { allowHosts: ['127.0.0.1'] }).port).toBe('9');
  });
});

describe('createSafeLookup (DNS-time check)', () => {
  it('rejects hostnames that resolve to private addresses', async () => {
    const lookup = createSafeLookup();
    const err = await new Promise((resolve) => lookup('localhost', { all: true }, (e) => resolve(e)));
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it('honors the allow-list', async () => {
    const lookup = createSafeLookup({ allowHosts: ['localhost'] });
    const res = await new Promise((resolve) => lookup('localhost', { all: true }, (e, a) => resolve(e ?? a)));
    expect(Array.isArray(res)).toBe(true);
  });
});

describe('SafeHttpClient', () => {
  let main: { server: Server; url: string };
  let other: { server: Server; url: string };
  let lastAuthOnOther: string | undefined;
  let http: SafeHttpClient;

  beforeAll(async () => {
    other = await startServer((req, res) => {
      lastAuthOnOther = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ other: true }));
    });
    main = await startServer((req, res, body) => {
      const u = new URL(req.url!, 'http://x');
      switch (u.pathname) {
        case '/json':
          return res
            .writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-custom': 'yes' })
            .end(JSON.stringify({ method: req.method, query: Object.fromEntries(u.searchParams), body: body ? JSON.parse(body) : null, ct: req.headers['content-type'], ua: req.headers['user-agent'] }));
        case '/text':
          return res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
        case '/404':
          return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"nope"}');
        case '/401':
          return res.writeHead(401).end('unauthorized');
        case '/503':
          return res.writeHead(503, { 'retry-after': '7' }).end('busy');
        case '/429':
          return res.writeHead(429).end();
        case '/slow':
          return setTimeout(() => res.end('late'), 1_000);
        case '/big':
          res.writeHead(200);
          res.write('x'.repeat(600_000));
          return res.end('x'.repeat(600_000));
        case '/redirect':
          return res.writeHead(302, { location: '/json?redirected=1' }).end();
        case '/see-other':
          return res.writeHead(303, { location: '/json' }).end();
        case '/to-other':
          return res.writeHead(307, { location: `${other.url}/` }).end();
        case '/to-private':
          return res.writeHead(302, { location: 'http://10.0.0.1/' }).end();
        case '/loop':
          return res.writeHead(302, { location: '/loop' }).end();
        default:
          res.writeHead(500).end();
      }
    });
    http = new SafeHttpClient({ allowHosts: ['127.0.0.1'], maxResponseBytes: 1_000_000, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await http.close();
    main.server.close();
    other.server.close();
  });

  it('sends JSON bodies and query params, decodes JSON responses', async () => {
    const res = await http.request<{ method: string; query: object; body: object; ct: string; ua: string }>({
      url: `${main.url}/json`,
      method: 'POST',
      query: { a: 1, b: 'two', skip: undefined },
      body: { hello: 'world' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-custom']).toBe('yes');
    expect(res.data).toMatchObject({ method: 'POST', query: { a: '1', b: 'two' }, body: { hello: 'world' }, ct: 'application/json' });
    expect(res.data.ua).toMatch(/^FlowForge/);
  });

  it('returns text for non-JSON content', async () => {
    expect((await http.request({ url: `${main.url}/text` })).data).toBe('hello');
  });

  it('maps 4xx to FatalError and 5xx/429 to RetryableError', async () => {
    const notFound = await http.request({ url: `${main.url}/404` }).catch((e) => e);
    expect(notFound).toBeInstanceOf(FatalError);
    expect(notFound.code).toBe('HTTP_404');
    expect(notFound.details.body).toEqual({ error: 'nope' });

    const busy = await http.request({ url: `${main.url}/503` }).catch((e) => e);
    expect(busy).toBeInstanceOf(RetryableError);
    expect(busy.retryAfterMs).toBe(7_000);
    expect(await http.request({ url: `${main.url}/429` }).catch((e) => e)).toBeInstanceOf(RetryableError);
    expect(await http.request({ url: `${main.url}/401` }).catch((e) => e)).not.toBeInstanceOf(AuthError);
  });

  it('can return error responses instead of throwing', async () => {
    const res = await http.request({ url: `${main.url}/404`, throwOnError: false });
    expect(res.status).toBe(404);
  });

  it('times out as retryable', async () => {
    const err = await http.request({ url: `${main.url}/slow`, timeoutMs: 200 }).catch((e) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect(err.message).toMatch(/timed out/);
  });

  it('honours an external abort signal', async () => {
    const ctrl = new AbortController();
    const p = http.withSignal(ctrl.signal).request({ url: `${main.url}/slow` });
    setTimeout(() => ctrl.abort(), 50);
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect(err.code).toBe('ABORTED');
  });

  it('caps response size', async () => {
    const err = await http.request({ url: `${main.url}/big` }).catch((e) => e);
    expect(err.code).toBe('RESPONSE_TOO_LARGE');
  });

  it('follows redirects, converting 303 to GET', async () => {
    const r1 = await http.request<{ query: object }>({ url: `${main.url}/redirect` });
    expect(r1.data.query).toEqual({ redirected: '1' });
    const r2 = await http.request<{ method: string; body: unknown }>({ url: `${main.url}/see-other`, method: 'POST', body: { x: 1 } });
    expect(r2.data).toMatchObject({ method: 'GET', body: null });
  });

  it('strips credentials on cross-origin redirects', async () => {
    await http.request({ url: `${main.url}/to-other`, headers: { Authorization: 'Bearer secret' } });
    expect(lastAuthOnOther).toBeUndefined();
  });

  it('re-validates redirect targets (SSRF via redirect)', async () => {
    const err = await http.request({ url: `${main.url}/to-private` }).catch((e) => e);
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it('limits redirect hops', async () => {
    const err = await http.request({ url: `${main.url}/loop` }).catch((e) => e);
    expect(err.code).toBe('TOO_MANY_REDIRECTS');
  });

  it('blocks private targets when not allow-listed', async () => {
    const strict = new SafeHttpClient();
    await expect(strict.request({ url: `${main.url}/json` })).rejects.toBeInstanceOf(SsrfBlockedError);
    await strict.close();
  });

  it('resolves public hosts for non-HTTP protocols, blocking private ones', async () => {
    const strict = new SafeHttpClient();
    await expect(strict.resolvePublicHost('127.0.0.1')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    await expect(strict.resolvePublicHost('localhost')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    await expect(strict.resolvePublicHost('10.0.0.5')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    expect(await strict.resolvePublicHost('8.8.8.8')).toEqual({ address: '8.8.8.8', family: 4 });
    expect(await http.resolvePublicHost('127.0.0.1')).toEqual({ address: '127.0.0.1', family: 4 });
    await strict.close();
  });

  it('parses Retry-After', () => {
    expect(parseRetryAfter('10')).toBe(10_000);
    expect(parseRetryAfter('99999')).toBe(3_600_000);
    expect(parseRetryAfter(new Date(Date.now() + 5_000).toUTCString())).toBeGreaterThan(3_000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
  });
});
