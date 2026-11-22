import type { LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';

/** Routes Nest's internal logs (bootstrap, route mapping, …) through pino. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  private ctx(optionalParams: unknown[]): { context?: string } {
    const last = optionalParams[optionalParams.length - 1];
    return typeof last === 'string' ? { context: last } : {};
  }

  log(message: unknown, ...optionalParams: unknown[]) {
    this.logger.info(this.ctx(optionalParams), String(message));
  }
  error(message: unknown, ...optionalParams: unknown[]) {
    const [maybeStack] = optionalParams;
    this.logger.error(
      { ...this.ctx(optionalParams), stack: typeof maybeStack === 'string' ? maybeStack : undefined },
      String(message),
    );
  }
  warn(message: unknown, ...optionalParams: unknown[]) {
    this.logger.warn(this.ctx(optionalParams), String(message));
  }
  debug(message: unknown, ...optionalParams: unknown[]) {
    this.logger.debug(this.ctx(optionalParams), String(message));
  }
  verbose(message: unknown, ...optionalParams: unknown[]) {
    this.logger.trace(this.ctx(optionalParams), String(message));
  }
}
