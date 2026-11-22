# Writing a connector

A connector is one `defineApp({ auth, triggers, actions })` module. Input forms in the builder are
rendered from the JSON Schemas you declare, so there is no UI code to write.

## The 45-line example

[`packages/connectors/examples/discord.ts`](../packages/connectors/examples/discord.ts) is a complete
connector (auth + credential test + one action). A test keeps it under 50 lines.

```ts
export default defineApp({
  key: 'discord', name: 'Discord', description: '…', category: 'communication', icon: 'MessageCircle', color: '#5865F2',
  auth: {
    type: 'api_key',
    fields: objectSchema({ webhookUrl: { type: 'string', 'x-ui': { widget: 'password' } } }, ['webhookUrl']),
    test: async ({ auth, http }) => ({ label: (await http.request<{ name: string }>({ url: auth.webhookUrl })).data.name }),
  },
  actions: [{
    key: 'sendMessage', name: 'Send message', description: '…',
    input: objectSchema({ content: { type: 'string', minLength: 1 } }, ['content']),
    sampleOutput: { id: '123' },
    run: async ({ input, auth, http }) =>
      (await http.request({ url: auth.webhookUrl, method: 'POST', body: { content: input.content } })).data,
  }],
});
```

Register it by adding it to `BUILT_IN_APPS` in `packages/connectors/src/index.ts`.

## What the runtime gives you (`ctx`)

| Field | Notes |
|---|---|
| `input` | Templates already resolved, validated against your schema, defaults applied. |
| `auth` | Decrypted credentials of the selected connection. OAuth tokens are refreshed for you. |
| `http` | SSRF-protected client with timeouts and a size cap. Non-2xx throws `RetryableError` (429/5xx) or `FatalError` (4xx) unless `throwOnError: false`. `http.resolvePublicHost()` is for non-HTTP protocols. |
| `signal` | Aborted on step timeout or worker shutdown. Pass it to long operations. |
| `idempotencyKey` | `<runId>:<stepKey>`, stable across retries. Forward it to APIs that support idempotency. |
| `logger` | Lines appear in the run history for the step. |
| `isTest` | `true` when invoked by the builder's **Test** button. |
| `sandbox` | isolated-vm runtime (used by the Code app). |

## Errors steer the engine

| Throw | Effect |
|---|---|
| `RetryableError(msg, retryAfterMs?)` | Retried with exponential backoff (honours `retryAfterMs`). |
| `FatalError(msg, code)` | Run fails immediately. |
| `AuthError(msg)` | Run fails and the connection is flagged for reconnection. |
| `StopRun(reason)` | Run ends as FILTERED (not a failure). |
| `SuspendRun(date)` | Run pauses without holding a worker and resumes at `date`. |

Any other exception is treated as a bug: the run fails without retrying.

## Auth types

- `none`
- `api_key` / `basic` / `custom` with `fields` (JSON Schema). Mark secrets with `x-ui: { widget: 'password' }`.
- `oauth2` with `authorizeUrl`, `tokenUrl`, `scopes`, `clientIdEnv`, `clientSecretEnv` and optional
  `authorizeParams`/`pkce`. The platform runs the whole flow, encrypts the tokens and refreshes them.

Every type can define `test(ctx) → { label }`. The label is shown next to the connection.

## Triggers

| `kind` | You implement | Platform does |
|---|---|---|
| `webhook` | nothing | unique URL, ingestion, idempotency header |
| `schedule` | `schedule(config) → { cron, timezone } \| { everyMs }` | BullMQ job schedulers |
| `polling` | `poll(ctx) → { items: [{ id, data }], cursor? }` (oldest first) | interval, cursor storage, first-poll baseline, de-duplication by `id` |
| `app_webhook` | `subscribe` / `unsubscribe` / `verify?` / `parse` | public URL, raw body for signatures, per-event idempotency |

## Form hints (`x-ui`)

`widget` (`textarea`, `code`, `password`, `select`, `json`, `keyvalue`, `cron`, `toggle`, `number`),
`placeholder`, `help`, `dynamicOptions` (name of an `optionLoaders` entry), `dependsOn`, `advanced`,
`noTemplates`. Use `x-enumLabels` to give enum values readable labels.

## Validation

- `defineApp` validates keys, schemas and option-loader references when the module is imported.
- At publish time, configs are validated against `input`. Values containing `{{ templates }}` are
  type-checked at run time, but required fields still apply. Optional `validate(config)` adds
  semantic checks (e.g. cron syntax).
