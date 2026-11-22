import { AuthError, FatalError, type InboundRequest, RetryableError, validateInput } from '@flowforge/connector-sdk';
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry, parseFeed } from '../src';
import { a1Sheet } from '../src/apps/google-sheets';
import { actionCtx, FakeHttp, silentLogger, urlIncludes } from './harness';

const reg = createDefaultRegistry({});
const app = (k: string) => reg.get(k)!;
const base = { logger: silentLogger, signal: new AbortController().signal };

// ─── Slack ──────────────────────────────────────────────────
describe('Slack', () => {
  const slack = app('slack');
  const send = reg.getAction('slack', 'sendMessage')!;

  it('tests the token and labels the connection', async () => {
    const http = new FakeHttp().on(urlIncludes('auth.test'), () => ({ data: { ok: true, team: 'Acme', user: 'flowbot' } }));
    const info = await (slack.auth as any).test({ ...base, auth: { botToken: 'xoxb-1' }, http });
    expect(info).toEqual({ label: 'Acme (@flowbot)', team: 'Acme' });
    expect(http.requests[0]!.headers!.authorization).toBe('Bearer xoxb-1');
  });

  it('maps Slack errors: auth → AuthError, ratelimited → retry with Retry-After, others → fatal', async () => {
    const reply = (error: string, headers = {}) => new FakeHttp().on(() => true, () => ({ data: { ok: false, error }, headers }));
    await expect((slack.auth as any).test({ ...base, auth: { botToken: 'x' }, http: reply('invalid_auth') })).rejects.toBeInstanceOf(AuthError);
    const rl: any = await send.run(actionCtx({ input: { channel: 'C1', text: 'hi' }, auth: { botToken: 'x' }, http: reply('ratelimited', { 'retry-after': '7' }) })).catch((e: any) => e);
    expect(rl).toBeInstanceOf(RetryableError);
    expect(rl.retryAfterMs).toBe(7_000);
    const nf: any = await send.run(actionCtx({ input: { channel: 'C1', text: 'hi' }, auth: { botToken: 'x' }, http: reply('channel_not_found') })).catch((e: any) => e);
    expect(nf).toBeInstanceOf(FatalError);
    expect(nf.code).toBe('SLACK_CHANNEL_NOT_FOUND');
  });

  it('posts a message (stripping #) and lists channels for the picker', async () => {
    const http = new FakeHttp()
      .on(urlIncludes('chat.postMessage'), () => ({ data: { ok: true, channel: 'C9', ts: '1.2' } }))
      .on(urlIncludes('conversations.list'), () => ({ data: { ok: true, channels: [{ id: 'C1', name: 'general', is_private: false }, { id: 'G2', name: 'ops', is_private: true }] } }));
    const out = await send.run(actionCtx({ input: { channel: '#general', text: '*New lead*: Ada', unfurlLinks: false }, auth: { botToken: 'xoxb-1' }, http }));
    expect(out).toEqual({ ok: true, channel: 'C9', ts: '1.2' });
    expect(http.requests[0]!.body).toMatchObject({ channel: 'general', text: '*New lead*: Ada', unfurl_links: false });
    const opts = await slack.optionLoaders!.channels!({ ...base, auth: { botToken: 'xoxb-1' }, http, config: {}, workspaceId: 'w' });
    expect(opts).toEqual([{ label: '#general', value: 'C1' }, { label: '🔒ops', value: 'G2' }]);
  });

  it('validates credentials shape', () => {
    expect(validateInput((slack.auth as any).fields, { botToken: 'nope' }).ok).toBe(false);
    expect(validateInput((slack.auth as any).fields, { botToken: 'xoxb-123' }).ok).toBe(true);
  });
});

// ─── Telegram ───────────────────────────────────────────────
describe('Telegram', () => {
  const tg = app('telegram');
  const trigger = reg.getTrigger('telegram', 'newMessage');
  if (trigger?.kind !== 'app_webhook') throw new Error('missing');
  const token = '123456:ABCDEFGHIJKLMNOPQRSTUV';

  const inbound = (body: unknown, secret?: string): InboundRequest => ({
    method: 'POST',
    headers: secret ? { 'x-telegram-bot-api-secret-token': secret } : {},
    query: {},
    body,
    rawBody: JSON.stringify(body),
  });

  it('sends messages and maps errors', async () => {
    const http = new FakeHttp().on(urlIncludes('/sendMessage'), () => ({ data: { ok: true, result: { message_id: 7, date: 1767268800, chat: { id: 42, type: 'private' } } } }));
    const out = await reg.getAction('telegram', 'sendMessage')!.run(actionCtx({ input: { chatId: '42', text: 'hi', parseMode: 'none' }, auth: { botToken: token }, http }));
    expect(out).toEqual({ messageId: 7, chatId: 42, date: '2026-01-01T12:00:00.000Z' });
    expect(http.requests[0]!.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(http.requests[0]!.body).toMatchObject({ chat_id: '42', text: 'hi', parse_mode: undefined });

    const unauthorized = new FakeHttp().on(() => true, () => ({ status: 401, data: { ok: false, description: 'Unauthorized' } }));
    await expect((tg.auth as any).test({ ...base, auth: { botToken: token }, http: unauthorized })).rejects.toBeInstanceOf(AuthError);
    const flood = new FakeHttp().on(() => true, () => ({ status: 429, data: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } } }));
    const err: any = await reg.getAction('telegram', 'sendMessage')!.run(actionCtx({ input: { chatId: '1', text: 'x' }, auth: { botToken: token }, http: flood })).catch((e: any) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect(err.retryAfterMs).toBe(3_000);
  });

  it('subscribes with a secret token, verifies it in constant time, and unsubscribes', async () => {
    const http = new FakeHttp().on(() => true, () => ({ data: { ok: true, result: true } }));
    const sub = (await trigger.subscribe({ ...base, auth: { botToken: token }, http, input: {}, webhookUrl: 'https://h.test/hooks/app/tok', workspaceId: 'w', zapId: 'z' })) as { secret: string };
    expect(sub.secret).toMatch(/^[0-9a-f]{48}$/);
    expect(http.requests[0]!.body).toMatchObject({ url: 'https://h.test/hooks/app/tok', secret_token: sub.secret });

    const ctx = { auth: {}, subscription: sub, input: {} };
    expect(await trigger.verify!(inbound({}, sub.secret), ctx)).toBe(true);
    expect(await trigger.verify!(inbound({}, 'wrong'), ctx)).toBe(false);
    expect(await trigger.verify!(inbound({}), ctx)).toBe(false);
    expect(await trigger.verify!(inbound({}, ''), { ...ctx, subscription: null })).toBe(false);

    await trigger.unsubscribe({ ...base, auth: { botToken: token }, http, input: {}, webhookUrl: '', workspaceId: 'w', zapId: 'z' }, sub);
    expect(http.requests[1]!.url).toMatch(/deleteWebhook$/);
  });

  it('parses message updates into flat events keyed by update_id', async () => {
    const update = { update_id: 555, message: { message_id: 9, date: 1767268800, text: '/start', chat: { id: -100, type: 'group', title: 'Team' }, from: { id: 1, is_bot: false, first_name: 'Ada', username: 'ada' } } };
    expect(await trigger.parse(inbound(update))).toEqual([
      {
        id: '555',
        data: { updateId: 555, messageId: 9, text: '/start', date: '2026-01-01T12:00:00.000Z', chatId: -100, chatType: 'group', chatTitle: 'Team', fromId: 1, fromUsername: 'ada', fromName: 'Ada', isBot: false },
      },
    ]);
    expect(await trigger.parse(inbound({ update_id: 1, edited_message: {} }))).toEqual([]);
  });
});

// ─── Google Sheets ──────────────────────────────────────────
describe('Google Sheets', () => {
  const sheets = app('google-sheets');
  const addRow = reg.getAction('google-sheets', 'addRow')!;
  const auth = { accessToken: 'ya29.t' };

  it('appends a row with A1-escaped sheet names and returns the row number', async () => {
    const http = new FakeHttp().on(urlIncludes(':append'), () => ({ data: { updates: { updatedRange: "'Q1 ''Leads'''!A12:C12", updatedRows: 1, updatedCells: 3 } } }));
    const out = await addRow.run(actionCtx({ input: { spreadsheetId: 'sheet/1', worksheet: "Q1 'Leads'", values: ['Ada', 42, null] }, auth, http }));
    expect(out).toEqual({ spreadsheetId: 'sheet/1', updatedRange: "'Q1 ''Leads'''!A12:C12", updatedRows: 1, updatedCells: 3, rowNumber: 12 });
    const req = http.requests[0]!;
    expect(req.url).toBe(`https://sheets.googleapis.com/v4/spreadsheets/sheet%2F1/values/${encodeURIComponent("'Q1 ''Leads'''!A1")}:append`);
    expect(req.query).toMatchObject({ valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
    expect(req.body).toEqual({ majorDimension: 'ROWS', values: [['Ada', 42, '']] });
    expect(req.headers!.authorization).toBe('Bearer ya29.t');
    expect(a1Sheet('Sheet1')).toBe("'Sheet1'");
  });

  it('maps Google errors: 401 → reconnect, 429/5xx → retry, 403/404 → fatal with message', async () => {
    const fail = (status: number, message: string) => new FakeHttp().on(() => true, () => ({ status, data: { error: { message, status: 'X' } } }));
    const input = { spreadsheetId: 's', worksheet: 'Sheet1', values: ['a'] };
    await expect(addRow.run(actionCtx({ input, auth, http: fail(401, 'expired') }))).rejects.toBeInstanceOf(AuthError);
    await expect(addRow.run(actionCtx({ input, auth, http: fail(429, 'quota') }))).rejects.toBeInstanceOf(RetryableError);
    await expect(addRow.run(actionCtx({ input, auth, http: fail(503, 'backend') }))).rejects.toBeInstanceOf(RetryableError);
    const denied: any = await addRow.run(actionCtx({ input, auth, http: fail(403, 'The caller does not have permission') })).catch((e: any) => e);
    expect(denied).toBeInstanceOf(FatalError);
    expect(denied.message).toBe('Google API: The caller does not have permission');
  });

  it('loads spreadsheets and worksheets for the pickers (skipping templated ids)', async () => {
    const http = new FakeHttp()
      .on(urlIncludes('drive/v3/files'), () => ({ data: { files: [{ id: 'f1', name: 'CRM' }] } }))
      .on(urlIncludes('/spreadsheets/f1'), () => ({ data: { sheets: [{ properties: { title: 'Leads' } }, { properties: { title: 'Archive' } }] } }));
    const ctx = { ...base, auth, http, workspaceId: 'w' };
    expect(await sheets.optionLoaders!.spreadsheets!({ ...ctx, config: {} })).toEqual([{ label: 'CRM', value: 'f1' }]);
    expect(http.requests[0]!.query!.q).toContain("mimeType='application/vnd.google-apps.spreadsheet'");
    expect(await sheets.optionLoaders!.worksheets!({ ...ctx, config: { spreadsheetId: 'f1' } })).toEqual([
      { label: 'Leads', value: 'Leads' },
      { label: 'Archive', value: 'Archive' },
    ]);
    expect(await sheets.optionLoaders!.worksheets!({ ...ctx, config: { spreadsheetId: '{{ step1.id }}' } })).toEqual([]);
  });

  it('requests offline access so Google returns refresh tokens', () => {
    expect(sheets.auth).toMatchObject({ type: 'oauth2', authorizeParams: { access_type: 'offline', prompt: 'consent' } });
  });
});

// ─── RSS ────────────────────────────────────────────────────
const RSS2 = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Blog</title>
  <item><title>Second &amp; newest</title><link>https://b.test/2</link><guid>https://b.test/2</guid><pubDate>Tue, 03 Feb 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Hello <b>world</b></p>]]></description><category>news</category><category>launch</category><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Ada</dc:creator></item>
  <item><title>First</title><link>https://b.test/1</link><pubDate>Mon, 02 Feb 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;
const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed</title>
  <entry><id>urn:uuid:1</id><title>Atom entry</title><link rel="alternate" href="https://a.test/1"/><link rel="edit" href="https://a.test/edit/1"/><updated>2026-01-05T00:00:00Z</updated><summary>Sum</summary><author><name>Grace</name></author><category term="dev"/></entry>
</feed>`;

describe('RSS', () => {
  it('parses RSS 2.0 oldest-first with stable ids and cleaned summaries', () => {
    const feed = parseFeed(RSS2);
    expect(feed.title).toBe('Example Blog');
    expect(feed.items.map((i) => i.title)).toEqual(['First', 'Second & newest']);
    expect(feed.items[1]).toMatchObject({
      id: 'https://b.test/2',
      link: 'https://b.test/2',
      summary: 'Hello world',
      author: 'Ada',
      publishedAt: '2026-02-03T10:00:00.000Z',
      categories: ['news', 'launch'],
    });
    expect(feed.items[0]!.id).toBe('https://b.test/1'); // falls back to link without guid
  });

  it('parses Atom feeds', () => {
    expect(parseFeed(ATOM).items).toEqual([
      { id: 'urn:uuid:1', title: 'Atom entry', link: 'https://a.test/1', summary: 'Sum', author: 'Grace', publishedAt: '2026-01-05T00:00:00.000Z', categories: ['dev'] },
    ]);
  });

  it('rejects non-feeds', () => {
    expect(() => parseFeed('<html><body>nope</body></html>')).toThrow(/Not a valid RSS/);
  });

  it('polls through the SSRF-safe client and returns items for dedupe', async () => {
    const trigger = reg.getTrigger('rss', 'newItem');
    if (trigger?.kind !== 'polling') throw new Error('missing');
    expect(trigger.intervalSeconds).toBe(300);
    const http = new FakeHttp().on(urlIncludes('feed.xml'), () => ({ data: RSS2 }));
    const res = await trigger.poll({ ...base, auth: {}, http, input: { url: 'https://b.test/feed.xml' }, cursor: undefined, workspaceId: 'w', zapId: 'z' });
    expect(res.items.map((i) => i.id)).toEqual(['https://b.test/1', 'https://b.test/2']);
    expect(res.items[1]!.data).toMatchObject({ title: 'Second & newest', feedTitle: 'Example Blog' });
    expect(http.requests[0]!.responseType).toBe('text');
  });
});
