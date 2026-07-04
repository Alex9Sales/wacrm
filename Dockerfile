# syntax=docker/dockerfile:1

# ============================================================================
# CRM Fluxia — multi-stage image for a multi-container deploy.
#
# ONE image, TWO runtime roles (selected by the container's command):
#   web    → node server.js          (Next.js standalone server, port 3000)
#   worker → npx tsx src/worker/index.ts   (BullMQ broadcast worker)
#
# The Next build produces `.next/standalone` (a lean traced server bundle),
# which the web role runs. The worker is NOT part of the Next build — it's
# raw TypeScript executed by `tsx` at runtime — so the final image also
# carries a full production `node_modules` (tsx is a prod dependency now) and
# the `src/` + `tsconfig.json` + `drizzle/` trees the worker imports.
#
# No ffmpeg: the composer records Opus/WhatsApp-accepted audio client-side
# (see src/components/inbox/message-composer.tsx), so there is no server-side
# transcode step. If that ever changes, add `ffmpeg` to the runner apk line.
# ============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — deps: install the FULL dependency tree once (cached on lockfile).
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
# libc6-compat: some native deps (e.g. transitive) expect glibc symbols on
# Alpine's musl. Cheap insurance.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2 — builder: compile the Next app into `.next/standalone`.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* are inlined into the client bundle AT BUILD TIME — they must
# be present now, not just at runtime. Pass via --build-arg (or Coolify's
# build-time env). Anything read only server-side (DATABASE_URL, REDIS_URL,
# secrets…) is NOT needed here and must NOT be baked in.
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — runner: the shipped image. Runs BOTH web and worker.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache libc6-compat wget
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root runtime user.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# --- Next.js WEB (standalone) -------------------------------------------------
# `.next/standalone` already contains server.js + the traced node_modules the
# web server needs. `.next/static` and `public` are served alongside it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# --- WORKER (tsx + raw source) ------------------------------------------------
# The standalone bundle does NOT include the worker or tsx, so we overlay a
# full production node_modules (tsx is a prod dep) and the source the worker
# imports at runtime. This node_modules also supersedes the partial one inside
# standalone — a superset, so the web server keeps working.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

USER nextjs
EXPOSE 3000

# Liveness probe against the cheap /api/health endpoint. Coolify/Traefik can
# use this too; it never touches the DB or Redis.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

# Default command = web. The worker container overrides this with:
#   command: npx tsx src/worker/index.ts
CMD ["node", "server.js"]
