# syntax=docker/dockerfile:1

# ============================================================================
# CRM Fluxia — multi-stage image for a multi-container deploy.
#
# ONE image, TWO runtime roles (selected by the container's command):
#   web    → node server.js                 (Next.js standalone server, port 3000)
#   worker → npx tsx src/worker/index.ts    (BullMQ broadcast worker)
#
# The Next build produces `.next/standalone` (a lean traced server bundle),
# which the web role runs. The worker is NOT part of the Next build — it's
# raw TypeScript executed by `tsx` at runtime — so the final image also
# carries a full production `node_modules` (tsx is a prod dependency now) and
# the `src/` + `tsconfig.json` + `drizzle/` trees the worker imports.
#
# Base = node:22-slim (Debian/glibc), NOT alpine/musl: esbuild (pulled by
# tsx / drizzle-kit) ships glibc prebuilt binaries and its install-time
# version check fails on musl. Debian sidesteps that.
# ============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — deps: install the FULL dependency tree once (cached on lockfile).
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --include=dev is mandatory: Coolify injects NODE_ENV=production as a build
# env, which would make npm OMIT devDependencies — but `next build` needs them
# (typescript, tailwindcss, @tailwindcss/postcss…). Force the full tree.
RUN npm ci --include=dev

# ---------------------------------------------------------------------------
# Stage 2 — builder: compile the Next app into `.next/standalone`.
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* are inlined into the client bundle AT BUILD TIME — they must
# be present now, not just at runtime. Anything read only server-side
# (DATABASE_URL, REDIS_URL, secrets…) is NOT needed here and must NOT be baked.
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
# 🛡️ id do deploy (SHA) → next.config deploymentId (skew protection)
ARG DEPLOYMENT_ID=dev
ENV DEPLOYMENT_ID=${DEPLOYMENT_ID}
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — runner: the shipped image. Runs BOTH web and worker.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app

# wget for the HEALTHCHECK; slim ships none by default.
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget \
  && rm -rf /var/lib/apt/lists/*

ARG DEPLOYMENT_ID=dev
ENV DEPLOYMENT_ID=${DEPLOYMENT_ID}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# node:22-slim ships a non-root `node` user (uid 1000) — reuse it.

# --- Next.js WEB (standalone) -------------------------------------------------
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# --- WORKER (tsx + raw source) ------------------------------------------------
# The standalone bundle excludes the worker + tsx, so overlay a full production
# node_modules (tsx is a prod dep) plus the source the worker imports. This
# node_modules supersedes the partial standalone one — a superset — so web
# still works.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/drizzle ./drizzle

# Role dispatcher: same image runs web (default) or worker (APP_ROLE=worker).
# Needed because Coolify's "docker image" deployment runs the image's own
# entrypoint/CMD and does NOT apply a per-app start-command override.
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER node
EXPOSE 3000

# Liveness probe against the cheap /api/health endpoint (no DB/Redis).
# Role-aware: the worker serves no HTTP, so it reports healthy unconditionally
# (probing :3000 would always fail → a false "unhealthy"). Only the web role
# actually hits /api/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD sh -c 'if [ "$APP_ROLE" = "worker" ]; then exit 0; else wget --quiet --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1; fi'

# Entrypoint selects the role from APP_ROLE (worker) else defaults to web.
ENTRYPOINT ["./docker-entrypoint.sh"]
