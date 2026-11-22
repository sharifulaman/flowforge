import { AuthError, defineApp, FatalError, type HttpClient, objectSchema, RetryableError } from '@flowforge/connector-sdk';
import { randomBytes, timingSafeEqual } from 'node:crypto';

interface TgResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

async function tg<T>(http: HttpClient, token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await http.request<TgResponse<T>>({
    url: `https://api.telegram.org/bot${token}/${method}`,
    method: 'POST',
    body: body ?? {},
    throwOnError: false,
  });
  const d = res.data;
  if (d?.ok) return d.result;
  const msg = d?.description ?? `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 404) throw new AuthError(`Telegram rejected the bot token (${msg})`);
  if (res.status === 429) throw new RetryableError(`Telegram rate limit: ${msg}`, (d?.parameters?.retry_after ?? 5) * 1000);
  if (res.status >= 500) throw new RetryableError(`Telegram error: ${msg}`);
  throw new FatalError(`Telegram error: ${msg}`, `TELEGRAM_${res.status}`);
}

interface TgMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
  from?: { id: number; is_bot: boolean; first_name?: string; last_name?: string; username?: string; language_code?: string };
}

export function flattenMessage(updateId: number, m: TgMessage) {
  return {
    updateId,
    messageId: m.message_id,
    text: m.text ?? m.caption ?? '',
    date: new Date(m.date * 1000).toISOString(),
    chatId: m.chat.id,
    chatType: m.chat.type,
    chatTitle: m.chat.title ?? m.chat.username ?? m.chat.first_name ?? null,
    fromId: m.from?.id ?? null,
    fromUsername: m.from?.username ?? null,
    fromName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || null,
    isBot: m.from?.is_bot ?? false,
  };
}

export default defineApp({
  key: 'telegram',
  name: 'Telegram',
  description: 'Send and receive messages with a Telegram bot.',
  category: 'communication',
  icon: 'Send',
  color: '#229ED9',
  auth: {
    type: 'api_key',
    instructions: 'Talk to @BotFather on Telegram, run /newbot and paste the token it gives you.',
    fields: objectSchema(
      { botToken: { type: 'string', title: 'Bot token', pattern: '^\\d+:[A-Za-z0-9_-]{20,}$', 'x-ui': { widget: 'password', placeholder: '123456:ABC-DEF…' } } },
      ['botToken'],
    ),
    test: async ({ auth, http }) => {
      const me = await tg<{ username: string; first_name: string }>(http, auth.botToken, 'getMe');
      return { label: `@${me.username}`, botName: me.first_name };
    },
  },
  triggers: [
    {
      key: 'newMessage',
      name: 'New message',
      kind: 'app_webhook',
      description: 'Fires when your bot receives a message. Note: a bot can deliver updates to only one webhook at a time.',
      input: objectSchema({
        chatId: { type: 'string', title: 'Only from chat ID', description: 'Leave empty to receive messages from every chat.' },
      }),
      sampleOutput: flattenMessage(100, {
        message_id: 42,
        date: 1767268800,
        text: 'Hello bot!',
        chat: { id: 123456789, type: 'private', first_name: 'Ada' },
        from: { id: 123456789, is_bot: false, first_name: 'Ada', last_name: 'Lovelace', username: 'ada' },
      }),
      async subscribe({ auth, http, webhookUrl }) {
        const secret = randomBytes(24).toString('hex');
        await tg(http, auth.botToken, 'setWebhook', { url: webhookUrl, secret_token: secret, allowed_updates: ['message', 'channel_post'] });
        return { secret };
      },
      async unsubscribe({ auth, http }) {
        await tg(http, auth.botToken, 'deleteWebhook', {});
      },
      verify(req, { subscription }) {
        const expected = Buffer.from(String((subscription as { secret?: string } | null)?.secret ?? ''));
        const got = Buffer.from(req.headers['x-telegram-bot-api-secret-token'] ?? '');
        return expected.length > 0 && expected.length === got.length && timingSafeEqual(expected, got);
      },
      parse(req) {
        const update = req.body as { update_id?: number; message?: TgMessage; channel_post?: TgMessage };
        const m = update?.message ?? update?.channel_post;
        if (!m || typeof update.update_id !== 'number') return [];
        return [{ id: String(update.update_id), data: flattenMessage(update.update_id, m) }];
      },
    },
  ],
  actions: [
    {
      key: 'sendMessage',
      name: 'Send message',
      description: 'Send a text message to a chat, group or channel.',
      input: objectSchema(
        {
          chatId: { type: 'string', title: 'Chat ID', minLength: 1, description: 'Numeric chat id, or @channelusername' },
          text: { type: 'string', title: 'Text', minLength: 1, maxLength: 4096, 'x-ui': { widget: 'textarea' } },
          parseMode: { type: 'string', title: 'Formatting', enum: ['none', 'MarkdownV2', 'HTML'], default: 'none', 'x-ui': { widget: 'select' } },
          disableNotification: { type: 'boolean', title: 'Send silently', default: false },
        },
        ['chatId', 'text'],
      ),
      sampleOutput: { messageId: 43, chatId: 123456789, date: '2026-01-01T12:00:00.000Z' },
      async run({ input, auth, http }) {
        const m = await tg<TgMessage>(http, auth.botToken, 'sendMessage', {
          chat_id: input.chatId,
          text: input.text,
          parse_mode: input.parseMode === 'none' ? undefined : input.parseMode,
          disable_notification: input.disableNotification,
        });
        return { messageId: m.message_id, chatId: m.chat.id, date: new Date(m.date * 1000).toISOString() };
      },
    },
  ],
});
