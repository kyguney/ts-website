# TrendScore.io — Website

Coming-soon landing page and waitlist for **TrendScore.io**, an AI-powered
long/short prediction SaaS for the crypto market.

Built with **Next.js 15 (App Router)**, **TypeScript**, **Prisma**, and
**MySQL**. Containerized with Docker and ready to deploy on **Coolify**.

## Stack

- Next.js 15 + React 19 (App Router, `output: "standalone"`)
- Prisma ORM → MySQL
- Waitlist API at `POST /api/waitlist`
- Multi-stage Docker build + `docker-compose` for local MySQL

## Project structure

```
src/
  app/
    layout.tsx            # fonts + metadata
    page.tsx              # coming-soon page (server component)
    globals.css           # all styles
    api/waitlist/route.ts # POST endpoint -> MySQL via Prisma
  components/
    WaitlistForm.tsx       # client: email capture form
    ChartBackground.tsx    # client: animated candlestick canvas
  lib/
    prisma.ts             # shared Prisma client
prisma/
  schema.prisma           # WaitlistEntry model (mysql)
Dockerfile
docker-compose.yml        # local app + MySQL
docker-entrypoint.sh      # runs `prisma db push`, then starts the server
```

## Local development

### Option A — app on host, MySQL in Docker (fastest dev loop)

```bash
cp .env.example .env          # already provided with local defaults
docker compose up -d db       # start MySQL only
npm install
npm run db:push               # create the waitlist table
npm run dev                   # http://localhost:3000
```

### Option B — full stack in Docker

```bash
docker compose up --build     # builds the app + starts MySQL
# open http://localhost:3000
```

The entrypoint runs `prisma db push` automatically on container start, so the
`waitlist_entries` table is created before the app serves traffic.

## Environment variables

| Variable       | Purpose                                   |
| -------------- | ----------------------------------------- |
| `DATABASE_URL` | MySQL connection string used by Prisma    |

`docker-compose.yml` also reads `MYSQL_*` values to provision the local DB.
See `.env.example`.

## Deploying on Coolify

You do **not** use the compose `db` service in production — use Coolify's
managed MySQL instead.

1. **Create a MySQL database** in Coolify (Resources → Databases → MySQL).
   Note the internal connection details it provides.

2. **Create the application** from this Git repo.
   - Build pack: **Dockerfile** (Coolify detects the `Dockerfile` automatically).
   - Exposed port: **3000**.

3. **Set the environment variable** on the application:

   ```
   DATABASE_URL=mysql://<user>:<password>@<internal-mysql-host>:3306/<database>
   ```

   Use the **internal** host Coolify shows for the MySQL service so traffic
   stays on the private network.

4. **Deploy.** On boot, `docker-entrypoint.sh` runs `prisma db push` to create
   the `waitlist_entries` table, then starts the Next.js standalone server.

5. Point your domain (`trendscore.io`) at the app in Coolify and enable HTTPS.

### Viewing collected emails

```sql
SELECT email, createdAt FROM waitlist_entries ORDER BY createdAt DESC;
```

Or run Prisma Studio locally against the same `DATABASE_URL`:

```bash
npx prisma studio
```

## Troubleshooting

**`P1017: Server has closed the connection` on `prisma db push`**

MySQL 8.4 enables TLS with a self-signed certificate by default, and Prisma
drops the connection during the handshake. Append `?sslaccept=accept_invalid_certs`
to `DATABASE_URL` (already done in `.env.example` and `docker-compose.yml`), and
use `127.0.0.1` instead of `localhost` to force a TCP connection:

```
mysql://user:pass@127.0.0.1:3306/trendscore?sslaccept=accept_invalid_certs
```

On Coolify, if the managed MySQL uses a self-signed cert, add the same
`?sslaccept=accept_invalid_certs` parameter to the app's `DATABASE_URL`.

## Notes

- The schema is applied with `prisma db push` (no migration history) since the
  waitlist is a single table. When the SaaS schema grows, switch to
  `prisma migrate` and change the entrypoint to `prisma migrate deploy`.
- This landing page is the foundation for the full SaaS app; the API route and
  Prisma setup carry directly into the product build.
