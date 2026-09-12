import { NextRequest, NextResponse } from "next/server";

// -----------------------------------------------------------------------------
// Middleware: maintenance gate + dashboard auth guard.
//
// 1. Maintenance mode (NEXT_PUBLIC_MAINTENANCE_MODE === "true"): every page is
//    rewritten to the Coming Soon page ("/"). Read at request time, so you can
//    flip it in Coolify and restart to go live — no rebuild.
//
// 2. When live, unauthenticated visits to protected routes (/dashboard) are
//    redirected to /login. We do a lightweight session-cookie presence check
//    here (Edge runtime); the actual session is verified in the server
//    components via auth().
//
// API routes, Next internals, and static assets are excluded via the matcher.
// -----------------------------------------------------------------------------

const MAINTENANCE_ALLOWLIST = ["/"];
const PROTECTED_PREFIXES = ["/dashboard"];

// NextAuth v5 session cookie names (secure prefix in production/https).
const SESSION_COOKIES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

function isMaintenanceMode(): boolean {
  return process.env.NEXT_PUBLIC_MAINTENANCE_MODE === "true";
}

function hasSessionCookie(req: NextRequest): boolean {
  return SESSION_COOKIES.some((name) => req.cookies.has(name));
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isMaintenanceMode()) {
    // Let the allowlisted page and any asset request through untouched. Asset
    // requests are Next internals (/_next/*) and static public files (anything
    // with a file extension, e.g. /logo.png, /favicon.svg). Without this, the
    // rewrite below turns e.g. /logo.png and /_next/image into the Coming Soon
    // HTML, which renders as a broken image on the gate page.
    const isAsset =
      pathname.startsWith("/_next/") || /\.[a-zA-Z0-9]+$/.test(pathname);
    if (MAINTENANCE_ALLOWLIST.includes(pathname) || isAsset) {
      return NextResponse.next();
    }
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.rewrite(url);
  }

  // Live: guard protected routes.
  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
  if (isProtected && !hasSessionCookie(req)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.svg|robots.txt).*)"],
};
