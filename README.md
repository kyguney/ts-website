# TrendScore.io — Website

**TrendScore.io** — an AI-powered long/short prediction SaaS for the crypto
market. Includes a Coming Soon gate, marketing/demo landing page, authentication,
and a Free/Pro subscription flow powered by Freemius.

Built with **Next.js 15 (App Router)** + **TypeScript**, **Prisma** →
**PostgreSQL**, **Redis**, **NextAuth**, and **Freemius**. Containerized with a
production multi-stage **Docker** build and deployable on **Coolify**.

## Stack

- Next.js 15 + React 19 (App Router, `output: "standalone"`)
- Prisma ORM → PostgreSQL 16 (versioned migrations)
- Redis 7 (via `ioredis`) — optional, degrades gracefully if unset
- NextAuth v5 — email/password + optional Google/Microsoft OAuth
- Freemius — hosted checkout, embedded Customer Portal, webhooks, Free/Pro gating
- Tailwind CSS v4 + shadcn/ui + the Freemius React Starter Kit
- Runtime maintenance gate via `NEXT_PUBLIC_MAINTENANCE_MODE`
- Health endpoint at `GET /api/health`; waitlist API at `POST /api/waitlist`

## Project structure

```
src/
  app/
    layout.tsx              # fonts + metadata
    page.tsx                # coming-soon page (server component)
    globals.css             # styles
    api/waitlist/route.ts   # POST -> Postgres via Prisma
    api/health/route.ts     # GET  -> 200 health check (db + redis status)
  components/
    WaitlistForm.tsx        # client: email capture form
    ChartBackground.tsx     # client: animated candlestick canvas
  lib/
    prisma.ts               # shared Prisma client
    redis.ts                # shared Redis client (optional)
  middleware.ts             # maintenance-mode gate
prisma/
  schema.prisma             # provider = postgresql
  migrations/               # versioned SQL migrations
Dockerfile                  # 4-stage: deps -> builder -> prisma-cli -> runner
entrypoint.sh               # runs `prisma migrate deploy`, then the server
docker-compose.yml          # LOCAL: app + postgres + redis
docker-compose.prod.yml     # Coolify "Docker Compose" deployment (Option B)
.env.example                # local template
.env.production.example      # production / Coolify template
```

## Local development

Local defaults are already in `.env.example`. Copy it once:

```bash
cp .env.example .env
```

### Option A — app on host, Postgres + Redis in Docker (fastest loop)

```bash
docker compose up -d db redis   # start Postgres + Redis only
npm install
npm run db:migrate:dev          # apply migrations to the local DB
npm run dev                     # http://localhost:3000
```

### Option B — full stack in Docker

```bash
npm run docker:up        # build + start app, Postgres & Redis (background)
npm run docker:up:logs   # same, but stream logs in the foreground
npm run docker:logs      # tail logs of the running stack
npm run docker:down      # stop and remove the stack
npm run docker:restart   # down, then rebuild + start
npm run docker:fresh     # rebuild with --no-cache (use if a change won't show)
# open http://localhost:3000
```

> Tip: if a code change doesn't appear, Docker is serving a cached image —
> run `npm run docker:fresh`.

In Docker, `entrypoint.sh` runs `prisma migrate deploy` on start, so the schema
is applied before the app serves traffic.

## Environment variables

See `.env.example` (local) and `.env.production.example` (production). Summary:

| Variable                              | Purpose                                                   |
| ------------------------------------- | --------------------------------------------------------- |
| `NODE_ENV`                            | `production` in prod                                      |
| `DATABASE_URL`                        | PostgreSQL connection string (Prisma)                     |
| `REDIS_URL`                           | Redis connection string (optional)                        |
| `NEXT_PUBLIC_MAINTENANCE_MODE`        | `"true"`/`"false"` — Coming Soon gate (runtime)           |
| `NEXTAUTH_URL`                        | Public app URL (must match the Coolify domain)            |
| `NEXTAUTH_SECRET`                     | NextAuth signing secret (`openssl rand -base64 32`)       |
| `NEXT_PUBLIC_APP_URL` *(build)*       | Public app URL for Freemius checkout/portal callbacks     |
| `FREEMIUS_PRODUCT_ID`                 | Freemius product id                                       |
| `FREEMIUS_PUBLIC_KEY`                 | Freemius public key (`pk_…`)                              |
| `FREEMIUS_SECRET_KEY`                 | Freemius secret key (`sk_…`); also verifies webhooks      |
| `FREEMIUS_API_KEY`                    | Freemius API key (required by the SDK)                    |
| `NEXT_PUBLIC_FREEMIUS_STORE_ID` *(build)*      | Freemius store id (client-visible)               |
| `NEXT_PUBLIC_FREEMIUS_PRO_PRICING_ID` *(build)*| Pro plan pricing id — gates Pro access (`85687`) |
| `GOOGLE_CLIENT_ID` / `_SECRET`        | Optional Google OAuth (buttons show only when both set)   |
| `MICROSOFT_CLIENT_ID` / `_SECRET`     | Optional Microsoft OAuth (buttons show only when both set)|

> Variables marked *(build)* are `NEXT_PUBLIC_*` and are inlined at **build
> time** — set them as **Build Variables/Args** in Coolify, not just runtime env.
> `NEXT_PUBLIC_MAINTENANCE_MODE` is the exception: it is read at runtime so you
> can toggle it without rebuilding.

---

# Coolify Deployment Guide

There are two supported paths. Pick one:

- **Option A — Coolify Managed Resources:** deploy the app from the `Dockerfile`
  and attach Coolify's one-click **PostgreSQL** and **Redis** services. Recommended.
- **Option B — Docker Compose:** deploy `docker-compose.prod.yml` as a Coolify
  "Docker Compose" application (app + Postgres + Redis in one stack).

## 1. Prerequisites in Coolify

1. **Create a Project and an Environment** (e.g. `TrendScore` → `production`).
2. **Add a PostgreSQL service (v16):** Project → **+ New** → Database →
   PostgreSQL 16. Note the **internal** host, database, user, and password.
3. **Add a Redis service (v7):** Project → **+ New** → Database → Redis 7.
   Note its internal host.

> Internal hostnames keep DB/cache traffic on Coolify's private Docker network.
> Use the service name Coolify shows (commonly `postgres` / `redis`), not a
> public address.

## 2. Application Setup

1. **Connect the GitHub repository:** Project → **+ New** → Application →
   your Git source → this repo/branch.
2. **Build pack:**
   - **Option A:** choose **Dockerfile** (Coolify auto-detects it). Nixpacks also
     works, but the provided `Dockerfile` is optimized (standalone output,
     non-root, migrations on start) and is the recommended choice.
   - **Option B:** choose **Docker Compose** and set the compose file to
     `docker-compose.prod.yml`.
3. **Port mapping:** expose port **3000** (the app listens on `0.0.0.0:3000`).
4. **Health check:** point Coolify's HTTP health check at **`/api/health`**
   (returns `200`). The image also declares a Docker `HEALTHCHECK` against it.
5. **Environment variables:** add everything from `.env.production.example`.
   - Option A: set `DATABASE_URL` and `REDIS_URL` to the managed services'
     internal connection strings.
   - Option B: set `POSTGRES_DB/USER/PASSWORD` (compose builds `DATABASE_URL`
     from them) plus the app secrets.
6. **Custom domain:** attach `https://trendscore.io` and enable HTTPS.

## 3. Database Migration Pipeline (no downtime / no races)

Migrations run automatically via `entrypoint.sh` → `prisma migrate deploy`
before the server starts. `migrate deploy` only applies committed migration
files, is idempotent, non-interactive, and never resets data.

To avoid **race conditions** when running multiple app replicas:

- Keep the app at **1 replica during a deploy that includes a new migration**,
  then scale out. This ensures a single process applies the migration.
- `prisma migrate deploy` takes a Postgres **advisory lock**, so concurrent
  starts won't double-apply — but single-replica migration deploys remain the
  safest default.
- Write **backward-compatible** migrations (expand/contract): add columns/tables
  first, deploy code that tolerates old + new, then remove old columns in a later
  migration. This keeps old and new containers healthy during a rolling deploy.

Create new migrations locally, commit them, then deploy:

```bash
npm run db:migrate:dev -- --name your_change   # generates prisma/migrations/*
git add prisma/migrations && git commit -m "db: your_change"
# push -> Coolify redeploy -> entrypoint applies it with `migrate deploy`
```

Manual apply (if ever needed) from any box with the repo + `DATABASE_URL`:

```bash
npm run db:deploy
```

## 4. Auth & Freemius Setup

### Authentication (NextAuth / Auth.js)

- Email + password registration (`/register`) and login (`/login`) work out of
  the box — set `NEXTAUTH_URL` and `NEXTAUTH_SECRET`.
- Google and Microsoft (Outlook) sign-in are wired but **inactive until you set
  their keys**. Provide `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and/or
  `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`; the buttons then appear
  automatically. Set each provider's redirect/callback URL to
  `https://trendscore.io/api/auth/callback/<provider>`.
- Every new user starts on the **Free** plan.

### Freemius (checkout, portal, webhooks)

Set `FREEMIUS_PRODUCT_ID`, `FREEMIUS_PUBLIC_KEY`, `FREEMIUS_SECRET_KEY`,
`FREEMIUS_API_KEY`, `NEXT_PUBLIC_FREEMIUS_STORE_ID`, and
`NEXT_PUBLIC_FREEMIUS_PRO_PRICING_ID` (from Freemius → Settings → Keys, and
Plans → Pro → pricing id).

1. **Checkout redirect** (Freemius Dashboard → your product → checkout/redirect
   settings): set the redirect endpoint to

   ```
   https://trendscore.io/api/checkout
   ```

   The SDK verifies the signature and syncs the license on return.

2. **Webhook** (Freemius Dashboard → Webhooks): set the URL to

   ```
   https://trendscore.io/api/webhooks/freemius
   ```

   Select the license events: `license.created`, `license.extended`,
   `license.shortened`, `license.updated`, `license.cancelled`,
   `license.expired`, `license.plan.changed`, `license.deleted`.

   Webhooks are authenticated with `FREEMIUS_SECRET_KEY` (HMAC signature) — there
   is **no separate webhook secret** to configure.

3. **In-app flows:**
   - `/dashboard/upgrade` — Freemius pricing table + checkout for Free users.
   - `/dashboard/billing` — embedded Freemius **Customer Portal** (manage
     subscription, payment method, invoices) via `/api/portal`.
   - A Pro purchase creates a `user_fs_entitlement` row (matched by email);
     access is gated by comparing the entitlement's pricing id to
     `NEXT_PUBLIC_FREEMIUS_PRO_PRICING_ID`.

## 5. Maintenance Mode (Coming Soon → Live)

`NEXT_PUBLIC_MAINTENANCE_MODE` is read **at runtime** by `middleware.ts`, so you
can flip it in Coolify **without a rebuild**:

1. Coolify → Application → **Environment Variables**.
2. Set `NEXT_PUBLIC_MAINTENANCE_MODE`:
   - `"true"` → all pages show the Coming Soon page.
   - `"false"` → the full app is served.
3. **Restart** the application (Coolify → Restart). The change applies on the
   next container start — no image rebuild required.

`/api/health` and `/api/waitlist` stay reachable in either mode.

## Viewing collected emails

```bash
npm run db:studio    # Prisma Studio against DATABASE_URL
```

```sql
SELECT email, "createdAt" FROM waitlist_entries ORDER BY "createdAt" DESC;
```

## Notes

- Auth (email/password, plus optional Google/Microsoft) and Freemius billing
  (checkout, embedded customer portal, webhooks, Free/Pro gating) are fully
  implemented. The dashboard signal data is currently **mock/sample** — the real
  prediction engine is ported in a later phase.
- Redis is optional: if `REDIS_URL` is unset the app still runs (the client is
  `null` and callers degrade gracefully).
- `NEXT_PUBLIC_*` values are inlined at build time; set them as Coolify Build
  Variables (see the environment variables table).
