import { AuthError, defineApp, FatalError, type HttpClient, objectSchema, RetryableError } from '@flowforge/connector-sdk';

const API = 'https://slack.com/api';
const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'missing_scope']);

/** Slack returns HTTP 200 with `{ ok: false, error }`; map that to engine errors. */
async function slack<T>(http: HttpClient, token: string, method: string, body?: Record<string, unknown>, query?: Record<string, string>): Promise<T> {
  const res = await http.request<{ ok: boolean; error?: string } & T>({
    url: `${API}/${method}`,
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body,
    query,
  });
  if (res.data.ok) return res.data;
  const err = res.data.error ?? 'unknown_error';
  if (AUTH_ERRORS.has(err)) throw new AuthError(`Slack rejected the token (${err})`);
  if (err === 'ratelimited') throw new RetryableError('Slack rate limit hit', Number(res.headers['retry-after'] ?? 30) * 1000);
  if (err === 'internal_error' || err === 'fatal_error' || err === 'service_unavailable') throw new RetryableError(`Slack error: ${err}`);
  throw new FatalError(`Slack error: ${err}`, `SLACK_${err.toUpperCase()}`);
}

export default defineApp({
  key: 'slack',
  name: 'Slack',
  description: 'Send messages to Slack channels.',
  category: 'communication',
  icon: 'Hash',
  color: '#4A154B',
  auth: {
    type: 'api_key',
    instructions:
      'Create a Slack app at api.slack.com/apps, add the bot scopes chat:write, chat:write.public and channels:read, install it to your workspace and paste the Bot User OAuth Token (xoxb-…).',
    fields: objectSchema(
      { botToken: { type: 'string', title: 'Bot token', pattern: '^xox[bp]-', 'x-ui': { widget: 'password', placeholder: 'xoxb-…' } } },
      ['botToken'],
    ),
    test: async ({ auth, http }) => {
      const r = await slack<{ team: string; user: string }>(http, auth.botToken, 'auth.test', {});
      return { label: `${r.team} (@${r.user})`, team: r.team };
    },
  },
  optionLoaders: {
    channels: async ({ auth, http }) => {
      const r = await slack<{ channels: Array<{ id: string; name: string; is_private: boolean }> }>(http, auth.botToken, 'conversations.list', undefined, {
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
        limit: '500',
      });
      return r.channels.map((c) => ({ label: `${c.is_private ? '🔒' : '#'}${c.name}`, value: c.id }));
    },
  },
  actions: [
    {
      key: 'sendMessage',
      name: 'Send channel message',
      description: 'Post a message to a channel.',
      input: objectSchema(
        {
          channel: { type: 'string', title: 'Channel', minLength: 1, 'x-ui': { dynamicOptions: 'channels', placeholder: '#general or C0123…' } },
          text: { type: 'string', title: 'Message', minLength: 1, maxLength: 40_000, 'x-ui': { widget: 'textarea', help: 'Supports Slack mrkdwn: *bold*, _italic_, <https://x.com|links>' } },
          username: { type: 'string', title: 'Bot name', 'x-ui': { advanced: true } },
          iconEmoji: { type: 'string', title: 'Bot icon emoji', 'x-ui': { advanced: true, placeholder: ':robot_face:' } },
          threadTs: { type: 'string', title: 'Reply in thread (ts)', 'x-ui': { advanced: true } },
          unfurlLinks: { type: 'boolean', title: 'Unfurl links', default: true, 'x-ui': { advanced: true } },
        },
        ['channel', 'text'],
      ),
      sampleOutput: { ok: true, channel: 'C0123ABCD', ts: '1712345678.000100', permalink: null },
      async run({ input, auth, http }) {
        const r = await slack<{ channel: string; ts: string }>(http, auth.botToken, 'chat.postMessage', {
          channel: input.channel.replace(/^#/, ''),
          text: input.text,
          username: input.username,
          icon_emoji: input.iconEmoji,
          thread_ts: input.threadTs,
          unfurl_links: input.unfurlLinks,
        });
        return { ok: true, channel: r.channel, ts: r.ts };
      },
    },
  ],
});
