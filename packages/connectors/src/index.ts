import { ConnectorRegistry, type DefinedApp } from '@flowforge/connector-sdk';
import schedule from './core/schedule';
import webhook from './core/webhook';

export { nextRuns, validateCron, isValidTimezone } from './core/schedule';

/** Every built-in app. Add new connectors here. */
export const BUILT_IN_APPS: DefinedApp[] = [webhook, schedule];

export function createDefaultRegistry(env: Record<string, string | undefined> = process.env): ConnectorRegistry {
  return new ConnectorRegistry(BUILT_IN_APPS, env);
}
