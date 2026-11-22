import { AuthError, FatalError } from '@flowforge/connector-sdk';
import { SafeHttpClient } from '@flowforge/safe-http';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../src';
import { actionCtx, silentLogger } from './harness';

const reg = createDefaultRegistry({});
const smtp = reg.get('smtp')!;
const send = reg.getAction('smtp', 'sendEmail')!;

interface Received {
  from: string;
  to: string[];
  raw: string;
}
let received: Received[] = [];
let server: SMTPServer;
let port: number;
const http = new SafeHttpClient({ allowHosts: ['127.0.0.1'] });

beforeAll(async () => {
  server = new SMTPServer({
    secure: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, _session, cb) {
      if (auth.username === 'mailer' && auth.password === 's3cret') return cb(null, { user: 'mailer' });
      cb(Object.assign(new Error('Invalid username or password'), { responseCode: 535 }));
    },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        received.push({ from: String(session.envelope.mailFrom && (session.envelope.mailFrom as { address: string }).address), to: session.envelope.rcptTo.map((r) => r.address), raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.server.address() as AddressInfo).port;
});
beforeEach(() => {
  received = [];
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await http.close();
});

const auth = (over: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port,
  security: 'none',
  username: 'mailer',
  password: 's3cret',
  fromEmail: 'robot@flowforge.test',
  fromName: 'FlowForge Robot',
  ...over,
});
const test = (a: Record<string, unknown>, client = http) =>
  (smtp.auth as any).test({ auth: a, http: client, logger: silentLogger, signal: new AbortController().signal });

describe('SMTP', () => {
  it('verifies credentials', async () => {
    expect(await test(auth())).toEqual({ label: `robot@flowforge.test via 127.0.0.1` });
    await expect(test(auth({ password: 'wrong' }))).rejects.toBeInstanceOf(AuthError);
  });

  it('sends email with a stable Message-ID derived from the idempotency key', async () => {
    const out = await send.run(
      actionCtx({
        input: { to: 'ada@example.com, grace@example.com', cc: '', subject: 'New lead: Ada', text: 'Hello!', html: '<p>Hello!</p>' },
        auth: auth(),
        http,
      }),
    );
    expect(out).toMatchObject({ messageId: '<run_1.step1@flowforge>', accepted: ['ada@example.com', 'grace@example.com'], rejected: [] });
    expect(received).toHaveLength(1);
    expect(received[0]!.from).toBe('robot@flowforge.test');
    expect(received[0]!.to).toEqual(['ada@example.com', 'grace@example.com']);
    expect(received[0]!.raw).toContain('Subject: New lead: Ada');
    expect(received[0]!.raw).toContain('From: FlowForge Robot <robot@flowforge.test>');
    expect(received[0]!.raw).toContain('Message-ID: <run_1.step1@flowforge>');
  });

  it('requires a body (publish-time validation)', () => {
    expect(send.validate!({ to: 'a@b.co', subject: 's' })).toEqual([{ field: 'text', message: 'Provide a plain-text or HTML body' }]);
  });

  it('refuses SMTP hosts on private networks (SSRF)', async () => {
    const strict = new SafeHttpClient();
    const err: any = await test(auth(), strict).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect((err as FatalError).code).toBe('SSRF_BLOCKED');
    await expect(test(auth({ host: 'metadata.google.internal' }), strict)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    await strict.close();
  });

  it('treats connection failures as retryable', async () => {
    const err: any = await send.run(actionCtx({ input: { to: 'a@b.co', subject: 's', text: 't' }, auth: auth({ port: 1 }), http })).catch((e: any) => e);
    expect(err.constructor.name).toBe('RetryableError');
  });
});
