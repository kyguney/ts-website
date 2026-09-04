import Redis from "ioredis";

// Shared Redis client. Reused across hot-reloads in development to avoid
// opening a new connection on every request/module reload.
//
// REDIS_URL is optional: if it is not set, `redis` is null and callers should
// treat Redis as unavailable (degrade gracefully rather than crash). This keeps
// the coming-soon site working even before Redis is provisioned.
const globalForRedis = globalThis as unknown as {
  redis: Redis | null | undefined;
};

function createClient(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) {
    return null;
  }

  const client = new Redis(url, {
    // Fail fast instead of buffering commands forever if Redis is down.
    maxRetriesPerRequest: 3,
    // Connect on first command rather than at import time. This keeps `next
    // build` and cold starts quiet when Redis isn't reachable yet.
    lazyConnect: true,
    // Reconnect with backoff (capped) on transient errors.
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

  client.on("error", (err) => {
    // Log but don't throw — Redis outages must not take the app down.
    console.error("[redis] connection error:", err.message);
  });

  return client;
}

export const redis: Redis | null =
  globalForRedis.redis ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}

/** Returns true if a Redis client is configured and currently ready. */
export function isRedisReady(): boolean {
  return !!redis && redis.status === "ready";
}
