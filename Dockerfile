# syntax=docker/dockerfile:1

# ---------- Base ----------
FROM node:22-alpine AS base
# libc6-compat helps some native deps (incl. Prisma engine) on Alpine.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ---------- Dependencies ----------
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# Install all deps; postinstall runs `prisma generate`.
RUN npm ci

# ---------- Builder ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL is not needed to build; Prisma client is generated from schema.
RUN npm run build
# Guarantee a public/ dir exists so the runner COPY never fails, even if the
# repo has no static assets.
RUN mkdir -p public

# ---------- Runner ----------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as non-root.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone server output (minimal node_modules + server.js).
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The Prisma Client (engine + generated client) is already traced into the
# standalone bundle above. We only need to ensure the generated client under
# node_modules/.prisma is present for the init script to import at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

# Startup schema-sync script (uses the bundled Prisma Client, not the CLI).
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

# Entrypoint applies the DB schema, then starts the server.
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER nextjs
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
