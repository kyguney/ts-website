// ---------------------------------------------------------------------------
// GET /api/ws/token — hands the browser a short-lived credential for the WS
// gateway. The NextAuth session cookie is httpOnly, so the client can't read
// it directly; this endpoint (same-origin, session-authenticated) returns the
// raw session JWT string plus the resolved plan. The client passes the token
// to the gateway as `?token=…`, where it's verified with NEXTAUTH_SECRET.
// ---------------------------------------------------------------------------

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { getUserPlan } from "@/lib/user-entitlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// NextAuth v5 session-cookie names (secure prefix on https).
const SESSION_COOKIE_NAMES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
];

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  const store = await cookies();
  let token: string | null = null;
  for (const name of SESSION_COOKIE_NAMES) {
    const c = store.get(name);
    if (c?.value) {
      token = c.value;
      break;
    }
  }

  if (!token) {
    // JWT strategy always issues a cookie; absence means an unexpected state.
    return NextResponse.json(
      { ok: false, error: "No session token found." },
      { status: 401 },
    );
  }

  const plan = await getUserPlan(userId);

  // Cache-Control: never cache a credential.
  return NextResponse.json(
    { ok: true, token, plan },
    { headers: { "Cache-Control": "no-store" } },
  );
}
