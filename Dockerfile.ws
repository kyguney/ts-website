# syntax=docker/dockerfile:1

# =============================================================================
# Lightweight image for the client WebSocket Gateway (Phase 4).
#
# A standalone long-running Node process (NOT the Next.js server) that holds the
# many long-lived browser WebSocket connections, verifies the NextAuth session
# JWT, subscribes ONCE to Redis Pub/Sub, and fans messages out to connections
# with plan-based (Free/Pro) channel authorization.
#
# Mirrors Dockerfile.worker: runs the TypeScript entrypoint directly with `tsx`
# (no compile step) and needs only a generated Prisma client (plan lookups hit
# the DB). Migrations are owned by the web container, not here.
# =============================================================================

# ---------- Base ----------
FROM node:22-alpine AS base
# libc6-compat helps the Prisma query engine on Alpine (musl).
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ---------- Stage 1: deps ----------
# Production dependencies only. `ws`, `ioredis`, `next-auth`, `@prisma/client`
# are all runtime deps; `tsx` is a devDependency, installed separately in the
# runner so the prod tree stays lean.
FROM base AS deps
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# Generate the Prisma client (postinstall is skipped by --ignore-scripts).
RUN npx prisma generate

# ---------- Stage 2: runner ----------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 gateway

# Prod dependency tree + generated Prisma client from the deps stage.
COPY --from=deps --chown=gateway:nodejs /app/node_modules ./node_modules
COPY --chown=gateway:nodejs package.json ./package.json
COPY --chown=gateway:nodejs tsconfig.json ./tsconfig.json
COPY --chown=gateway:nodejs prisma ./prisma
COPY --chown=gateway:nodejs src ./src

# `tsx` runs the TypeScript entrypoint + resolves the `@/*` tsconfig path alias.
# Installing into the existing prod `node_modules` with `--no-save` is
# unreliable (npm may not materialize the package), so install tsx into an
# isolated prefix (/opt/tsx) and invoke its CLI file directly. The `test -f`
# fails the build loudly if the CLI ever goes missing, rather than crash-looping
# the container at runtime.
RUN --mount=type=cache,target=/root/.npm \
    npm install --prefix /opt/tsx --no-save --no-package-lock tsx@4.20.6 \
  && test -f /opt/tsx/node_modules/tsx/dist/cli.mjs

USER gateway

ENV WS_GATEWAY_PORT=3001
EXPOSE 3001

# Liveness: the gateway serves a tiny /health endpoint over HTTP on the same
# port; a healthy response means the event loop and Redis wiring are up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WS_GATEWAY_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx is the ESM/TS loader; run the gateway entrypoint. Invoke the CLI file
# directly from the isolated tsx install.
CMD ["node", "/opt/tsx/node_modules/tsx/dist/cli.mjs", "src/workers/ws-gateway.ts"]
