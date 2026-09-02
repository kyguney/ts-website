// Lightweight startup migration for the single waitlist table.
//
// Why not `prisma db push` here? The Next.js standalone runtime image does not
// bundle the full Prisma CLI dependency tree, so invoking the CLI fails. The
// Prisma *Client*, however, IS traced into the standalone bundle — so we use it
// to run an idempotent `CREATE TABLE IF NOT EXISTS`, which is all this schema
// needs. When the schema grows, switch to proper `prisma migrate deploy` run
// from an image/step that includes the CLI.

import { PrismaClient } from "@prisma/client";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS waitlist_entries (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    email     VARCHAR(191) NOT NULL,
    source    VARCHAR(64)  NULL,
    ip        VARCHAR(64)  NULL,
    userAgent VARCHAR(512) NULL,
    createdAt DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY waitlist_entries_email_key (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const MAX_ATTEMPTS = 10;
const RETRY_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("[init-db] WARNING: DATABASE_URL is not set; skipping schema sync.");
    return;
  }

  const prisma = new PrismaClient();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await prisma.$executeRawUnsafe(CREATE_TABLE_SQL);
      console.log("[init-db] Database schema is in sync (waitlist_entries ready).");
      await prisma.$disconnect();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= MAX_ATTEMPTS) {
        console.error(`[init-db] ERROR: schema sync failed after ${MAX_ATTEMPTS} attempts: ${msg}`);
        await prisma.$disconnect().catch(() => {});
        // Don't block app startup — surface the error but let the server boot.
        return;
      }
      console.log(`[init-db] DB not ready yet (attempt ${attempt}/${MAX_ATTEMPTS}): ${msg.split("\n")[0]}`);
      await sleep(RETRY_MS);
    }
  }
}

main().catch((e) => {
  console.error("[init-db] Unexpected error:", e);
});
