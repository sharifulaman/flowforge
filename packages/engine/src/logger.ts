import type { ConnectorLogger } from '@flowforge/connector-sdk';

interface PinoLike {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Adapt a pino logger to the connector-facing logger interface. */
export function toConnectorLogger(log: PinoLike): ConnectorLogger {
  return {
    debug: (msg, data) => log.debug(data ?? {}, msg),
    info: (msg, data) => log.info(data ?? {}, msg),
    warn: (msg, data) => log.warn(data ?? {}, msg),
    error: (msg, data) => log.error(data ?? {}, msg),
  };
}

export const silentConnectorLogger: ConnectorLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
