# syntax=docker/dockerfile:1

# =============================================================================
# Production multi-stage build for Next.js (App Router, standalone output)
# Optimized for Coolify. Stages: deps -> builder -> prisma-cli -> runner
# =============================================================================

# ---------- Base ----------
FROM node:22-alpine AS base
# libc6-compat helps native deps (incl. the Prisma query engine) on Alpine.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ---------- Stage 1: deps ----------
# Install full dependencies (with BuildKit cache mount for the npm cache).
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ---------- Stage 2: builder ----------
# Generate the Prisma client and compile Next.js to a standalone server.
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, so they
# must be provided as build args here (not just runtime env). In Coolify, set
# these as Build Variables. Runtime-only vars (DATABASE_URL, secrets) are NOT
# needed to build.
# NOTE: NEXT_PUBLIC_MAINTENANCE_MODE is intentionally NOT a build arg — it is
# read at runtime (middleware + server component) so you can toggle it in Coolify
# and restart without rebuilding.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_FREEMIUS_STORE_ID
ARG NEXT_PUBLIC_FREEMIUS_PRO_PRICING_ID
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_FREEMIUS_STORE_ID=$NEXT_PUBLIC_FREEMIUS_STORE_ID
ENV NEXT_PUBLIC_FREEMIUS_PRO_PRICING_ID=$NEXT_PUBLIC_FREEMIUS_PRO_PRICING_ID

COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `npm run build` runs `prisma generate && next build`.
# DATABASE_URL is not required to build.
RUN --mount=type=cache,target=/app/.next/cache \
    npm run build
# Guarantee a public/ dir exists so the runner COPY never fails.
RUN mkdir -p public

# ---------- Stage 3: prisma-cli ----------
# A self-contained install of ONLY the Prisma CLI (+ its transitive deps) so we
# can run `prisma migrate deploy` at container start without bloating the app
# image with the full dependency tree or breaking on partial copies.
FROM base AS prisma-cli
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-save prisma@$(node -p "require('./package.json').devDependencies.prisma.replace(/[^0-9.]/g,'')" 2>/dev/null || echo "6.19.3")

# ---------- Stage 4: runner ----------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# --- Next.js standalone server output ---
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# --- Prisma: schema, migrations, and a working CLI for `migrate deploy` ---
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=prisma-cli --chown=nextjs:nodejs /app/node_modules ./prisma-cli/node_modules

# --- Entrypoint: runs migrations, then launches the server ---
COPY --chown=nextjs:nodejs entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER nextjs
EXPOSE 3000

# Container-level healthcheck (Coolify also uses HTTP checks against /api/health).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "server.js"]
