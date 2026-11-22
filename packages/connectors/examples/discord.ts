import { defineApp, objectSchema } from '@flowforge/connector-sdk';

/** Example: a complete connector in under 50 lines (see docs/CONNECTORS.md). */
export default defineApp({
  key: 'discord',
  name: 'Discord',
  description: 'Post messages to a Discord channel via an incoming webhook.',
  category: 'communication',
  icon: 'MessageCircle',
  color: '#5865F2',
  auth: {
    type: 'api_key',
    instructions: 'Channel settings → Integrations → Webhooks → New webhook → Copy URL.',
    fields: objectSchema(
      { webhookUrl: { type: 'string', title: 'Webhook URL', pattern: '^https://discord\\.com/api/webhooks/', 'x-ui': { widget: 'password' } } },
      ['webhookUrl'],
    ),
    test: async ({ auth, http }) => {
      const res = await http.request<{ name: string }>({ url: auth.webhookUrl });
      return { label: res.data.name };
    },
  },
  actions: [
    {
      key: 'sendMessage',
      name: 'Send message',
      description: 'Post a message to the webhook’s channel.',
      input: objectSchema(
        {
          content: { type: 'string', title: 'Message', minLength: 1, maxLength: 2000, 'x-ui': { widget: 'textarea' } },
          username: { type: 'string', title: 'Override bot name' },
        },
        ['content'],
      ),
      sampleOutput: { id: '1234567890', channelId: '987654321' },
      async run({ input, auth, http }) {
        const res = await http.request<{ id: string; channel_id: string }>({
          url: auth.webhookUrl,
          method: 'POST',
          query: { wait: 'true' },
          body: { content: input.content, username: input.username },
        });
        return { id: res.data.id, channelId: res.data.channel_id };
      },
    },
  ],
});
