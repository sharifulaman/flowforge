import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { RequestMethod } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLogger, type Logger } from '@flowforge/shared/node';
import { LogController } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createCsrfHook } from './common/csrf';
import type { ApiEnv } from './config/env';

export const API_PREFIX = 'api/v1';

/** Options passed to NestFactory.create / createNestApplication. */
export const NEST_APP_OPTIONS = { rawBody: true } as const;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export function createApiLogger(env: ApiEnv): Logger {
  return createLogger({
    name: 'api',
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });
}

export function createAdapter(env: ApiEnv, logger: Logger): FastifyAdapter {
  return new FastifyAdapter({
    loggerInstance: logger,
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024, // 1 MiB
    // We emit one structured 'request completed' line ourselves (see configureApp).
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    },
  });
}

/** Apply plugins, hooks and global settings. Shared by main.ts and the e2e tests. */
export async function configureApp(app: NestFastifyApplication, env: ApiEnv): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance();

  await app.register(fastifyCookie as never);

  // `content-type: application/json` with an empty body (common from curl/scripts on POSTs
  // like /enable) is treated as "no body" instead of a 400.
  fastify.addHook('onRequest', async (req) => {
    const len = req.headers['content-length'];
    const noBody = len === '0' || (len === undefined && req.headers['transfer-encoding'] === undefined);
    if (noBody) delete req.headers['content-type'];
  });

  // Webhooks may send anything (XML, CSV, …): accept it as a string instead of 415.
  // (JSON/form raw bodies are kept by Nest's `rawBody: true` option for signature checks.)
  fastify.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  await app.register(fastifyHelmet as never, {
    // The API serves JSON only; the web app sets its own CSP.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    // HSTS only makes sense when served over HTTPS (COOKIE_SECURE is our HTTPS signal).
    hsts: env.COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  const allowedOrigins = [env.WEB_URL, ...env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)];
  fastify.addHook('onRequest', createCsrfHook(allowedOrigins));

  fastify.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  fastify.addHook('onResponse', async (req, reply) => {
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info';
    req.log[level](
      {
        method: req.method,
        url: req.url.split('?')[0],
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  // Public webhooks live at the root: /hooks/:token, /hooks/app/:token
  app.setGlobalPrefix(API_PREFIX, { exclude: [{ path: 'hooks/{*path}', method: RequestMethod.ALL }] });
  app.enableShutdownHooks();
}
