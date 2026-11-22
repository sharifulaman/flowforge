import { AuthError, defineApp, FatalError, objectSchema, RetryableError } from '@flowforge/connector-sdk';
import nodemailer from 'nodemailer';

interface SmtpAuth {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username?: string;
  password?: string;
  fromEmail: string;
  fromName?: string;
}

/**
 * Build a transport that connects to the SSRF-vetted IP (no DNS rebinding) while validating the
 * TLS certificate against the configured hostname.
 */
async function transport(auth: SmtpAuth, resolve: (h: string) => Promise<{ address: string }>, timeoutMs = 20_000) {
  const { address } = await resolve(auth.host);
  return nodemailer.createTransport({
    host: address,
    port: auth.port,
    secure: auth.security === 'tls',
    requireTLS: auth.security === 'starttls',
    ignoreTLS: auth.security === 'none',
    auth: auth.username ? { user: auth.username, pass: auth.password ?? '' } : undefined,
    tls: { servername: auth.host },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
}

/** nodemailer error codes → engine errors. */
function mapSmtpError(err: unknown): Error {
  const e = err as { code?: string; responseCode?: number; message?: string };
  if (e.code === 'EAUTH' || e.responseCode === 535) return new AuthError(`SMTP login failed: ${e.message}`);
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(e.code ?? '') || (e.responseCode ?? 0) >= 400 && (e.responseCode ?? 0) < 500) {
    return new RetryableError(`SMTP temporarily unavailable: ${e.message}`);
  }
  if (err instanceof FatalError || err instanceof RetryableError) return err;
  return new FatalError(`SMTP error: ${e.message ?? String(err)}`, e.code ? `SMTP_${e.code}` : 'SMTP_ERROR');
}

const addressList = { type: 'string', description: 'Comma-separated email addresses' } as const;

export default defineApp({
  key: 'smtp',
  name: 'Email (SMTP)',
  description: 'Send email through any SMTP server.',
  category: 'communication',
  icon: 'Mail',
  color: '#2563eb',
  auth: {
    type: 'custom',
    instructions: 'Use the SMTP settings of your email provider (e.g. smtp.gmail.com:465 with an app password, or Postmark/SES/SendGrid SMTP credentials).',
    fields: objectSchema(
      {
        host: { type: 'string', title: 'SMTP host', minLength: 1, 'x-ui': { placeholder: 'smtp.example.com' } },
        port: { type: 'integer', title: 'Port', minimum: 1, maximum: 65535, default: 587 },
        security: { type: 'string', title: 'Security', enum: ['starttls', 'tls', 'none'], 'x-enumLabels': ['STARTTLS (587)', 'TLS/SSL (465)', 'None (not recommended)'], default: 'starttls' },
        username: { type: 'string', title: 'Username' },
        password: { type: 'string', title: 'Password', 'x-ui': { widget: 'password' } },
        fromEmail: { type: 'string', title: 'From email', format: 'email' },
        fromName: { type: 'string', title: 'From name' },
      },
      ['host', 'port', 'security', 'fromEmail'],
    ),
    test: async ({ auth, http }) => {
      const t = await transport(auth as SmtpAuth, (h) => http.resolvePublicHost(h), 10_000);
      try {
        await t.verify();
      } catch (err) {
        throw mapSmtpError(err);
      } finally {
        t.close();
      }
      return { label: `${auth.fromEmail} via ${auth.host}` };
    },
  },
  actions: [
    {
      key: 'sendEmail',
      name: 'Send email',
      description: 'Send a plain-text and/or HTML email.',
      input: objectSchema(
        {
          to: { ...addressList, title: 'To', minLength: 3 },
          cc: { ...addressList, title: 'CC', 'x-ui': { advanced: true } },
          bcc: { ...addressList, title: 'BCC', 'x-ui': { advanced: true } },
          replyTo: { type: 'string', title: 'Reply-to', 'x-ui': { advanced: true } },
          subject: { type: 'string', title: 'Subject', minLength: 1, maxLength: 998 },
          text: { type: 'string', title: 'Body (plain text)', 'x-ui': { widget: 'textarea' } },
          html: { type: 'string', title: 'Body (HTML)', 'x-ui': { widget: 'code', language: 'javascript', advanced: true } },
        },
        ['to', 'subject'],
      ),
      validate: (c) => (!c.text && !c.html ? [{ field: 'text', message: 'Provide a plain-text or HTML body' }] : []),
      sampleOutput: { messageId: '<abc123@example.com>', accepted: ['jane@example.com'], rejected: [] },
      async run({ input, auth, http, idempotencyKey }) {
        const a = auth as unknown as SmtpAuth;
        const t = await transport(a, (h) => http.resolvePublicHost(h));
        try {
          const info = await t.sendMail({
            from: a.fromName ? { name: a.fromName, address: a.fromEmail } : a.fromEmail,
            to: input.to,
            cc: input.cc || undefined,
            bcc: input.bcc || undefined,
            replyTo: input.replyTo || undefined,
            subject: input.subject,
            text: input.text || undefined,
            html: input.html || undefined,
            // Stable across retries so receiving systems can de-duplicate.
            messageId: `<${idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '.')}@flowforge>`,
          });
          return { messageId: info.messageId, accepted: info.accepted.map(String), rejected: info.rejected.map(String) };
        } catch (err) {
          throw mapSmtpError(err);
        } finally {
          t.close();
        }
      },
    },
  ],
});
