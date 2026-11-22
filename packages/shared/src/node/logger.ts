import pino, { type Logger, type LoggerOptions } from 'pino';

/** Paths scrubbed from every log line. Extend rather than replace. */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'apiKey',
  '*.apiKey',
  'secret',
  '*.secret',
  'clientSecret',
  '*.clientSecret',
  'authorization',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'credentials',
  '*.credentials',
];

export interface CreateLoggerOptions {
  name: string;
  level?: string;
  pretty?: boolean;
  base?: Record<string, unknown>;
}

export function loggerOptions(opts: CreateLoggerOptions): LoggerOptions {
  return {
    name: opts.name,
    level: opts.level ?? 'info',
    base: { service: opts.name, ...opts.base },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    ...(opts.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
          },
        }
      : {}),
  };
}

/** Structured JSON logger (pretty-printed in development when pino-pretty is installed). */
export function createLogger(opts: CreateLoggerOptions): Logger {
  return pino(loggerOptions(opts));
}

export type { Logger };
