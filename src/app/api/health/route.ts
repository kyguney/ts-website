import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { redis, isRedisReady } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Coolify (and other orchestrators) poll this endpoint for container health.
// It always returns HTTP 200 when the Node process is serving, so a transient
// database or cache blip does not cause the container to be marked unhealthy
// and restarted. Component status is reported in the body for observability.
export async function GET() {
  const checks: Record<string, "ok" | "down" | "disabled"> = {
    server: "ok",
    database: "down",
    redis: "disabled",
  };

  // Database check (best-effort, short-circuits quickly).
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "down";
  }

  // Redis check (optional — only if configured).
  if (redis) {
    try {
      const pong = await redis.ping();
      checks.redis = pong === "PONG" && isRedisReady() ? "ok" : "down";
    } catch {
      checks.redis = "down";
    }
  }

  return NextResponse.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: 200 }
  );
}
