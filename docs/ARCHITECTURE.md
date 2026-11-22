# FlowForge architecture

FlowForge is a workflow-automation platform: a **Zap** is one trigger plus N ordered actions;
each step's output can be referenced by later steps with `{{ stepKey.path }}` templates.

## Processes

| Process | Tech | Responsibility |
|---|---|---|
| `apps/web` | Next.js App Router, Tailwind, shadcn/ui | UI only. Proxies `/api/*` to the API so auth cookies are first-party. |
| `apps/api` | NestJS (Fastify) | Auth, CRUD, publishing, webhook ingestion. Enqueues work; **never executes user steps**. |
| `apps/worker` | BullMQ consumers | Executes runs, fires schedules, polls, runs the isolated-vm sandbox. *(phase c)* |
| PostgreSQL | Prisma | Source of truth. Every tenant row carries `workspaceId`. |
| Redis | BullMQ, rate limits, OAuth state | Queues: `ff-runs`, `ff-triggers`, `ff-test-step`. |

## Packages

```
shared         isomorphic: zod DTOs, queue contracts, templating; node-only: crypto, env, logger
connector-sdk  defineApp(), operation/auth types, JSON-schema validation, ConnectorRegistry
connectors     built-in apps + createDefaultRegistry()
engine         runtime core used by api + worker: SSRF-safe HTTP, CredentialStore (AES-256-GCM,
               OAuth refresh), publish validation, RunLauncher, TriggerManager, executor (phase c)
db             Prisma schema, migrations, client
```

Dependency direction: `shared ← connector-sdk ← connectors`, `shared/db/connector-sdk ← engine ← api/worker`.
The engine never imports `connectors`; the registry is injected (tests use fixture apps).

## Key flows

**Editing → publishing.** Steps are edited as drafts (`ZapStep`), every mutation in a transaction
holding `SELECT … FOR UPDATE` on the zap. Step keys (`trigger`, `step1`, `step2`, …) come from a
monotonic counter and are never reused, so reordering never re-points `{{ }}` references.
`POST /enable` validates the whole draft (apps/ops exist, connections valid, JSON-schema configs
with templated values exempt from type checks, cron syntax, template syntax, no forward/unknown
references), snapshots it into an immutable `ZapVersion` (only if it changed), and activates the
trigger. Runs always execute a version, so editing a live zap never affects in-flight runs.

**Triggers** (`TriggerManager`):
- webhook → random 192-bit token, URL `/hooks/:token` (stable across pause/resume; rotatable)
- schedule → BullMQ job scheduler `zap:<id>` (cron + timezone or fixed interval)
- polling → job scheduler at the connector's interval; cursor reset when the trigger changes
- app_webhook → connector `subscribe()` with `/hooks/app/:token`; `verify()` checks signatures
  over the raw body; `unsubscribe()` on pause (best effort)

**Run creation** (`RunLauncher`): insert `Run` with `@@unique([zapId, idempotencyKey])`, then
enqueue `{ runId }` with `jobId = runId`. Duplicates return the existing run. Idempotency keys:
`hdr:<Idempotency-Key>` for webhooks (no header ⇒ every request is distinct; never silently
dropped), `app:<event id>` for app events, `manual:<uuid>`, `replay:<runId>:<uuid>`.

**Replay.** Same zap version and trigger data. `from_failed` pre-seeds the succeeded prefix of
`StepRun`s; the engine skips completed steps (checkpointing) and resumes at the failure.

## Security

- Passwords: argon2id. Sessions: 15-min HS256 access JWT + rotating refresh token (hashed,
  reuse detection with a 30 s grace window for multi-tab races). httpOnly SameSite=Lax cookies;
  Origin/Referer check on cookie-authenticated mutations.
- API keys: `ff_live_…`, SHA-256 stored, workspace-bound, act with the creator's current role.
- Credentials: AES-256-GCM, random IV, AAD = `workspaceId:appKey`, key versions for rotation;
  secrets are never returned by the API.
- SSRF: http(s) only, no URL credentials, literal-IP and DNS-time private-range blocking (IPv4,
  IPv6, IPv4-mapped, NAT64, 6to4, metadata), connection pinned to the vetted address (undici
  custom lookup), redirects re-validated with credentials stripped cross-origin, size/time caps.
- Rate limits (Redis): auth 10/min/IP, API 300/min/IP, webhooks 300/min/token.
- Tenancy: all routes under `/workspaces/:id/…`; `WorkspaceGuard` returns 404 to non-members;
  every query includes `workspaceId`.
