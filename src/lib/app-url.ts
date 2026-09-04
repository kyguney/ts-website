/**
 * Resolve the app's public base URL for building Freemius callback/portal URLs
 * on the SERVER.
 *
 * NEXT_PUBLIC_APP_URL is baked at build time; if it wasn't provided as a build
 * arg (e.g. Coolify misconfig) it may be missing or "localhost". To be robust,
 * we prefer, in order:
 *   1. A valid non-localhost NEXT_PUBLIC_APP_URL / NEXTAUTH_URL
 *   2. The forwarded host from the incoming request (works behind Coolify's proxy)
 */
function isUsable(url: string | undefined): url is string {
  return (
    !!url &&
    /^https?:\/\//.test(url) &&
    !url.includes("localhost") &&
    !url.includes("127.0.0.1")
  );
}

export function resolveAppUrl(request?: Request): string {
  if (isUsable(process.env.NEXT_PUBLIC_APP_URL)) {
    return process.env.NEXT_PUBLIC_APP_URL!.replace(/\/$/, "");
  }
  if (isUsable(process.env.NEXTAUTH_URL)) {
    return process.env.NEXTAUTH_URL!.replace(/\/$/, "");
  }

  if (request) {
    const h = request.headers;
    const proto = h.get("x-forwarded-proto") ?? "https";
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) return `${proto}://${host}`;
  }

  // Last resort (local dev).
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}
