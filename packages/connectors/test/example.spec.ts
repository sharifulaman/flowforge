import { ConnectorRegistry, validateConfig } from '@flowforge/connector-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import discord from '../examples/discord';
import { actionCtx, FakeHttp, urlIncludes } from './harness';

describe('Connector SDK: a new app in < 50 lines', () => {
  it('the documented example stays under 50 lines', () => {
    const lines = readFileSync(join(__dirname, '../examples/discord.ts'), 'utf8').trimEnd().split('\n');
    expect(lines.length).toBeLessThan(50);
  });

  it('registers, renders a schema and runs', async () => {
    const reg = new ConnectorRegistry([discord]);
    const manifest = reg.manifest(discord);
    expect(manifest.auth).toMatchObject({ type: 'api_key', available: true });
    expect(manifest.actions[0]!.input.properties.content).toMatchObject({ type: 'string', maxLength: 2000 });
    expect(validateConfig(discord.actions[0]!.input, { content: '{{ trigger.body.text }}' })).toEqual([]);

    const hook = 'https://discord.com/api/webhooks/1/abc';
    const http = new FakeHttp().on(urlIncludes('/webhooks/'), () => ({ data: { id: 'm1', channel_id: 'c1' } }));
    const out = await discord.actions[0]!.run(actionCtx({ input: { content: 'Deploy finished ✅' }, auth: { webhookUrl: hook }, http }));
    expect(out).toEqual({ id: 'm1', channelId: 'c1' });
    expect(http.requests[0]).toMatchObject({ url: hook, method: 'POST', query: { wait: 'true' }, body: { content: 'Deploy finished ✅' } });
  });
});
