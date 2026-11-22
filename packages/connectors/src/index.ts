import { ConnectorRegistry, type DefinedApp } from '@flowforge/connector-sdk';
import googleSheets from './apps/google-sheets';
import rss from './apps/rss';
import slack from './apps/slack';
import smtp from './apps/smtp';
import telegram from './apps/telegram';
import code from './core/code';
import delay from './core/delay';
import filter from './core/filter';
import http from './core/http';
import schedule from './core/schedule';
import webhook from './core/webhook';

export { nextRuns, validateCron, isValidTimezone } from './core/schedule';
export { parseFeed } from './apps/rss';

/** Every built-in app. Add new connectors here. */
export const BUILT_IN_APPS: DefinedApp[] = [webhook, schedule, http, filter, delay, code, smtp, slack, googleSheets, telegram, rss];

export function createDefaultRegistry(env: Record<string, string | undefined> = process.env): ConnectorRegistry {
  return new ConnectorRegistry(BUILT_IN_APPS, env);
}
