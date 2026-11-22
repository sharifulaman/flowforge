# FlowForge

A workflow-automation platform: build **Zaps** — one trigger plus any number of actions — in a
visual builder, map data between steps with `{{ step1.field }}` templates, and let them run
automatically with retries, timeouts and full run history.

| | |
|---|---|
| **Triggers** | Webhooks (unique URL) · Schedule (interval or cron + timezone) · Polling (RSS/Atom) · App events (Telegram) |
| **Actions** | HTTP Request · Email (SMTP) · Slack · Google Sheets · Telegram · Delay · Filter · Code (sandboxed JavaScript) |
| **Builder** | React Flow canvas, schema-driven forms, field picker over real sample data, test any step, publish versions |
| **Runs** | Per-step input/output/logs, replay from the failed step, cancel, live dashboard |
| **Security** | AES-256-GCM credentials, SSRF-safe HTTP, isolated-vm sandbox, workspace isolation, rate limits |

---

## Contents

- [Quick start (Docker)](#quick-start-docker)
- [Local development](#local-development)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Testing](#testing)
- [Writing connectors](#writing-connectors)
- [API](#api)
- [Security model](#security-model)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Quick start (Docker)

Requirements: Docker 24+ with Compose v2.

```bash
cp .env.example .env
# Set real secrets in .env:
#   JWT_SECRET=$(openssl rand -base64 48)
#   ENCRYPTION_KEY=$(openssl rand -base64 32)
docker compose up -d --build
```

Open **http://localhost:3000**, create an account, and build your first Zap.

| Service | Port | Notes |
|---|---|---|
| `web` | 3000 | Next.js UI; proxies `/api/*` to the API |
| `api` | 4000 | REST API and public webhooks (`/hooks/:token`) |
| `worker` | — | Executes runs; health on `:4100/health` inside the network |
| `postgres` | 5432 | Data |
| `redis` | 6379 | Queues (AOF persistence, `noeviction`) |
| `migrate` | — | One-shot `prisma migrate deploy` before api/worker start |

Scale execution with `docker compose up -d --scale worker=3`.

> Webhook URLs shown in the builder use `HOOKS_PUBLIC_URL` (default `http://localhost:4000`).
> To receive webhooks from the internet, point it at a public HTTPS address (e.g. via a tunnel).

---

## Local development

Requirements: Node 22+, pnpm 10, Postgres 16 and Redis 7 (or `docker compose up -d postgres redis`).

```bash
pnpm install
cp .env.example .env
pnpm db:generate
pnpm db:deploy          # apply migrations
pnpm db:seed            # optional: demo@flowforge.dev / password123
pnpm dev                # web :3000, api :4000, worker, packages in watch mode
```

Useful scripts:

| Command | What it does |
|---|---|
| `pnpm build` | Build every package and app (Turborepo, cached) |
| `pnpm test` | Unit + integration tests (needs Postgres + Redis) |
| `pnpm typecheck` | `tsc --noEmit` everywhere |
| `pnpm db:migrate` | Create a new migration from `schema.prisma` changes |
| `pnpm e2e:system` | Full-system test against running api + worker |
| `pnpm e2e:ui` | Browser tests (Playwright) against running web + api + worker |

For local development against services on your machine (e.g. an HTTP action calling
`http://localhost:8080`), set `HTTP_ALLOW_PRIVATE_HOSTS=localhost,127.0.0.1` for the api and worker.
Never set it in production.

---

## Architecture

```
 Browser ──▶ web (Next.js) ──/api/*──▶ api (NestJS + Fastify) ──▶ PostgreSQL
                                          │   ▲
 Webhooks ──────────/hooks/*─────────────┘   │ Prisma
                                          │ BullMQ
                                          ▼
                                        Redis ◀──▶ worker (BullMQ consumers + isolated-vm)
```

- **The API never runs user steps.** It validates, stores, publishes and enqueues. All connector
  calls, sandboxed code and "Test step" requests run in the worker.
- **Zap versions.** Editing changes a draft. Turning a Zap on snapshots it into an immutable
  version; runs always execute a specific version, so edits never affect in-flight runs.
- **Stable step keys** (`trigger`, `step1`, `step2`, …) are never reused, so reordering never
  re-points `{{ }}` references.
- **Checkpointed execution.** One BullMQ job per run; each step's result is persisted, so retries,
  crashes and delayed resumes continue at the first unfinished step.

| Package | Purpose |
|---|---|
| `apps/web` | UI (Next.js App Router, Tailwind, shadcn/ui, React Flow) |
| `apps/api` | REST API, auth, webhooks |
| `apps/worker` | Run execution, schedules, polling, test-step, housekeeping, isolated-vm sandbox |
| `packages/shared` | zod schemas/DTOs, queue contracts, templating; node-only crypto/env/logger |
| `packages/connector-sdk` | `defineApp()`, types, JSON-schema validation, registry |
| `packages/connectors` | Built-in apps |
| `packages/safe-http` | SSRF-protected HTTP client |
| `packages/engine` | Executor, credential store, publish validation, triggers runtime |
| `packages/db` | Prisma schema, migrations, client |

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Execution semantics

| Situation | Behaviour |
|---|---|
| Transient error (network, 5xx, 429, timeout) | Retried up to 5 attempts: 10 s · 2ⁿ ±20 % (≤ 15 min), honouring `Retry-After` |
| Permanent error (4xx, invalid input, bug in connector) | Run fails immediately |
| Auth error | Run fails; the connection is flagged for reconnection |
| Filter condition false | Run ends as **Filtered** (not a failure) |
| Delay | Job parked in BullMQ until the time; no worker slot held |
| Step timeout | Default 30 s, configurable 1 s – 5 min per step |
| 10 consecutive failed runs | Zap switched off (status **Error**) |
| Duplicate webhook with `Idempotency-Key` | Returns the original run (200) |

---

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)). Values are
validated at startup with readable errors.

| Variable | Used by | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | api, worker | — | Postgres connection string |
| `REDIS_URL` | api, worker | `redis://localhost:6379` | Redis for BullMQ, rate limits, OAuth state |
| `JWT_SECRET` | api | — | ≥ 32 chars; signs access tokens |
| `ENCRYPTION_KEY` | api, worker | — | base64 of 32 random bytes (AES-256-GCM key) |
| `ENCRYPTION_KEY_VERSION` | api, worker | `1` | Version written into new ciphertexts |
| `ENCRYPTION_KEYS_PREVIOUS` | api, worker | — | `1:<base64>,2:<base64>` old keys for rotation |
| `WEB_URL` | api, worker | `http://localhost:3000` | Browser origin (CSRF allow-list, redirects) |
| `HOOKS_PUBLIC_URL` | api, worker | `http://localhost:4000` | Base of public webhook URLs |
| `API_INTERNAL_URL` | web (build) | `http://localhost:4000` | Where Next.js proxies `/api/*` |
| `COOKIE_SECURE` | api | `false` | `true` behind HTTPS (also enables HSTS) |
| `GOOGLE_CLIENT_ID` / `_SECRET` | api, worker | — | Google sign-in and Google Sheets OAuth |
| `GOOGLE_REDIRECT_URI` | api | `<WEB_URL>/api/v1/auth/google/callback` | Must be registered with Google |
| `HTTP_ALLOW_PRIVATE_HOSTS` | api, worker | — | Dev only: hosts exempt from SSRF blocking |
| `RUN_CONCURRENCY` | worker | `10` | Concurrent runs per worker process |
| `CODE_MEMORY_MB` / `CODE_TIMEOUT_MS` | worker | `64` / `5000` | Code step limits |
| `AUTO_PAUSE_AFTER_FAILURES` | worker | `10` | `0` disables auto-pause |
| `LOG_LEVEL` | all | `info` | pino level |

**Google OAuth:** create an OAuth client (Web application) and register two redirect URIs:
`<WEB_URL>/api/v1/auth/google/callback` (sign-in) and
`<WEB_URL>/api/v1/connections/oauth/callback` (Google Sheets connections).

---

## Testing

```bash
pnpm test
```

Tests run against real Postgres and Redis (databases `flowforge_test`, `flowforge_test_engine`,
`flowforge_test_worker`, and Redis DBs 13–15 — created by `docker/postgres-init.sql`). Suites:

| Package | Focus |
|---|---|
| `shared` | Templating engine (parser, filters, type preservation, prototype safety), crypto, env |
| `engine` | Executor (checkpointing, retries, timeouts, filter/delay/cancel), credentials + OAuth refresh, publish validation, triggers runtime, maintenance |
| `safe-http` | SSRF guard (IPv4/IPv6/mapped/NAT64, DNS-time checks, redirects), HTTP client |
| `connectors` | Every connector (fake HTTP / real local SMTP server), a < 50-line example connector |
| `worker` | Sandbox security and limits; end-to-end through real BullMQ |
| `api` | Auth, CSRF, rate limits, tenancy isolation, connections + OAuth, zaps, publishing, webhooks, runs, stats |
| `web` | Template/field-picker helpers, chart math, API client |

End-to-end (with api, worker and web running, `HTTP_ALLOW_PRIVATE_HOSTS=127.0.0.1`):

```bash
pnpm e2e:system   # API-level: build → publish → webhook → filter/code/delay/http → SSRF block
pnpm e2e:ui       # Playwright: builder, test step, publish issues, runs, replay, settings
```

Against the Docker stack (the override lets containers reach the test's echo server on the host):

```bash
docker compose -f docker-compose.yml -f docker/compose.e2e.yml up -d --build
ECHO_HOST=host.docker.internal ECHO_BIND=0.0.0.0 pnpm e2e:system
```

CI (`.github/workflows/ci.yml`) runs typecheck/tests/build, the end-to-end suites, and builds all
Docker images.

---

## Writing connectors

A connector is one `defineApp({ auth, triggers, actions })` module; the builder renders its
forms from JSON Schema. A complete Discord connector is 47 lines:
[`packages/connectors/examples/discord.ts`](packages/connectors/examples/discord.ts).
Guide: [`docs/CONNECTORS.md`](docs/CONNECTORS.md).

---

## API

All routes are under `/api/v1`. Authenticate with the session cookie (web app) or an API key:

```bash
curl -H "Authorization: Bearer ff_live_…" http://localhost:4000/api/v1/workspaces/<id>/runs
```

| Area | Routes |
|---|---|
| Auth | `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` · `GET /auth/google` |
| Workspaces | `GET/POST /workspaces` · `GET/PATCH/DELETE /workspaces/:id` · `…/members` · `…/api-keys` |
| Apps | `GET /apps` · `GET /apps/:key` · `POST /workspaces/:id/apps/:key/options` |
| Connections | `GET/POST …/connections` · `GET/PATCH/DELETE …/connections/:id` · `POST …/:id/test` · `GET …/connections/oauth/:app/start` |
| Zaps | `GET/POST …/zaps` · `GET/PATCH/DELETE …/zaps/:id` · `PUT …/trigger` · `POST/PATCH/DELETE …/steps[/:id]` · `POST …/steps/reorder` · `POST …/steps/:id/test` · `GET …/samples` · `POST …/enable` · `POST …/disable` · `GET …/versions` · `POST …/run` · `POST …/duplicate` |
| Runs | `GET …/runs` · `GET …/runs/:id` · `POST …/runs/:id/replay` · `POST …/runs/:id/cancel` |
| Monitoring | `GET …/stats?range=24h\|7d\|30d` · `GET /health` · `GET /health/ready` |
| Webhooks (public) | `ANY /hooks/:token` · `POST /hooks/app/:token` |

Errors are always `{ "error": { "code", "message", "issues"?, "requestId" } }`.

---

## Security model

- **Authentication:** argon2id passwords; 15-minute access JWT + rotating refresh token in
  httpOnly SameSite=Lax cookies, with reuse detection; Origin check on cookie-authenticated
  mutations; Google OAuth with PKCE.
- **API keys:** `ff_live_…`, stored as SHA-256, scoped to one workspace, acting with the creator's
  current role.
- **Tenancy:** every route is `/workspaces/:id/…`; non-members get 404; every query filters by
  `workspaceId`; tests assert cross-workspace access fails.
- **Credentials:** AES-256-GCM with a random IV, AAD bound to `workspaceId:appKey`, key versions
  for rotation; never returned by the API; OAuth refresh serialized with a row lock.
- **SSRF:** http(s) only; private, loopback, link-local (incl. `169.254.169.254`), CGNAT, IPv6
  ULA, IPv4-mapped/NAT64/6to4 blocked at URL *and* DNS time; the vetted IP is the one connected
  to; redirects re-validated with credentials stripped cross-origin; SMTP hosts checked the same
  way.
- **Code sandbox:** isolated-vm — a fresh V8 isolate per run, memory cap, CPU + wall-clock
  timeouts, no Node APIs, network or timers; JSON-only input/output.
- **Abuse limits:** auth 10/min/IP, API 300/min/IP, webhooks 300/min/token (Redis-backed); 1 MB
  request bodies; 1 MB step outputs; 512 KB trigger payloads.
- **Logging:** structured JSON with request/run ids; secrets, cookies and auth headers redacted;
  webhook auth headers and cookies are not stored in run history.

---

## Operations

- **Scaling:** run more `worker` replicas (BullMQ distributes jobs; each run is locked to one
  worker). The API is stateless — run several behind a load balancer.
- **Graceful shutdown:** SIGTERM stops new jobs, aborts in-flight steps and lets BullMQ retry them
  elsewhere (`stop_grace_period: 40s` in compose).
- **Health:** `GET /api/v1/health/ready` (Postgres + Redis), worker `:4100/health`.
- **Housekeeping:** every 5 minutes the worker re-enqueues runs whose jobs vanished (e.g. Redis
  failover) and purges polling dedupe keys older than 30 days.
- **Key rotation:** generate a new key, set `ENCRYPTION_KEY=<new>`, `ENCRYPTION_KEY_VERSION=2`,
  `ENCRYPTION_KEYS_PREVIOUS=1:<old>`. Credentials are re-encrypted as they are read.
- **Backups:** back up Postgres (all state). Redis holds queues — with AOF enabled, delayed runs
  survive restarts; if Redis is lost, housekeeping re-enqueues queued/waiting runs.
- **Building images behind a proxy:**
  `docker build --secret id=extra_ca,src=ca.pem --build-arg DEBIAN_MIRROR=https://deb.debian.org …`

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid environment configuration` on start | The message lists each bad variable; see [Configuration](#configuration) |
| Webhook returns `{"status":"sample_captured"}` | The Zap is off — the request was saved as sample data. Turn the Zap on |
| HTTP step fails with `SSRF_BLOCKED` | Target resolves to a private address. Use a public URL (or `HTTP_ALLOW_PRIVATE_HOSTS` in dev) |
| "Test step" times out (504) | The worker isn't running or can't reach Redis |
| Google Sheets shows "not configured" | Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and register the redirect URI |
| Telegram trigger never fires | `HOOKS_PUBLIC_URL` must be a public HTTPS URL; a bot can only have one webhook |
| Worker crashes with isolated-vm errors | Start Node with `--no-node-snapshot` (the scripts and image do) |

---

## Limitations

- No branching/paths or loops; one linear sequence of steps per Zap.
- Members must already have an account (no email invitations or verification emails).
- Dashboard buckets are UTC.
- No Prometheus metrics endpoint; monitoring is via the dashboard, run history, health endpoints
  and structured logs.
- The Slack connector uses a bot token (API key); Slack OAuth can be added through the SDK's
  generic OAuth2 support.
