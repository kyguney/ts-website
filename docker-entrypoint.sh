#!/bin/sh
set -e

# Apply the schema to the database before starting the app.
#
# We run a small Node script that uses the bundled Prisma *Client* (which IS
# included in the Next.js standalone output) to create the waitlist table
# idempotently. This avoids needing the Prisma CLI in the runtime image, which
# is not shipped with the standalone bundle.
if [ -f "scripts/init-db.mjs" ]; then
  node scripts/init-db.mjs || echo "[entrypoint] init-db reported an issue; continuing."
else
  echo "[entrypoint] WARNING: scripts/init-db.mjs not found; skipping schema sync."
fi

exec "$@"
