# syntax=docker/dockerfile:1.7
#
# FlowForge — one Dockerfile, four targets:
#   docker build -f docker/Dockerfile --target api     -t flowforge-api .
#   docker build -f docker/Dockerfile --target worker  -t flowforge-worker .
#   docker build -f docker/Dockerfile --target web     -t flowforge-web --build-arg API_INTERNAL_URL=http://api:4000 .
#   docker build -f docker/Dockerfile --target migrate -t flowforge-migrate .
#
# Behind a TLS-intercepting proxy, pass its CA as a BuildKit secret, and (if plain-HTTP apt
# mirrors are blocked) an HTTPS Debian mirror:
#   docker build --secret id=extra_ca,src=/path/to/ca.pem --build-arg DEBIAN_MIRROR=https://deb.debian.org ...

ARG NODE_IMAGE=node:22-bookworm-slim

# ─── base: Node + pnpm + OS libs Prisma needs ─────────────────────────────
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
ARG DEBIAN_MIRROR=
RUN --mount=type=secret,id=extra_ca,required=false,mode=0444 \
    set -eu; \
    if [ -n "$DEBIAN_MIRROR" ]; then sed -i "s#http://deb.debian.org#${DEBIAN_MIRROR}#g" /etc/apt/sources.list.d/debian.sources; fi; \
    if [ -f /run/secrets/extra_ca ]; then APT="apt-get -o Acquire::https::CAInfo=/run/secrets/extra_ca"; export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; else APT="apt-get"; fi; \
    export DEBIAN_FRONTEND=noninteractive; \
    $APT update && $APT install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# ─── build: install everything, generate Prisma client, build all packages ─
FROM base AS build
# Native addons (argon2, isolated-vm) ship prebuilt linux-x64/arm64 binaries; no toolchain needed.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/safe-http/package.json packages/safe-http/
COPY packages/connectors/package.json packages/connectors/
COPY packages/engine/package.json packages/engine/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false,mode=0444 \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile
COPY . .
# Baked into the Next.js rewrite table at build time (where the web server reaches the API).
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
RUN --mount=type=secret,id=extra_ca,required=false,mode=0444 \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm --filter @flowforge/db generate && pnpm turbo run build
# Pruned, production-only deployments (workspace deps resolved, devDeps dropped).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false,mode=0444 \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm --filter @flowforge/api deploy --prod --legacy --prefer-offline /out/api \
 && pnpm --filter @flowforge/worker deploy --prod --legacy --prefer-offline /out/worker \
 && pnpm --filter @flowforge/db deploy --legacy --prefer-offline /out/db \
 # The generated client (packages/db/generated) embeds its query engine; the Prisma CLI, its
 # migration engine and their deps arrive only as an auto-installed optional peer — drop them
 # from the runtime deployments (the migrate image keeps them).
 && for d in /out/api /out/worker; do \
      rm -rf "$d"/node_modules/.pnpm/prisma@6.* "$d"/node_modules/.pnpm/@prisma+engines@* "$d"/node_modules/.pnpm/effect@*; \
    done

# ─── migrate: one-shot `prisma migrate deploy` ─────────────────────────────
FROM base AS migrate
COPY --from=build --chown=node:node /out/db /app
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"]

# ─── api ───────────────────────────────────────────────────────────────────
FROM base AS api
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out/api /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ─── worker ────────────────────────────────────────────────────────────────
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out/worker /app
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# isolated-vm requires --no-node-snapshot on Node >= 20.
CMD ["node", "--no-node-snapshot", "dist/main.js"]

# ─── web (Next.js standalone) ──────────────────────────────────────────────
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
