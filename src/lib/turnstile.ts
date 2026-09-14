/**
 * Server-side Cloudflare Turnstile verification.
 *
 * Exchanges the client token for a pass/fail decision against Cloudflare's
 * `siteverify` endpoint using the server-only secret key.
 *
 * If `TURNSTILE_SECRET_KEY` is not configured, verification is skipped (returns
 * true) so local/dev environments without Turnstile keys keep working.
 */
const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteVerifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

export async function verifyTurnstileToken(
  token: string,
  remoteIp?: string | null
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;

  // No secret configured -> treat as disabled (dev-friendly).
  if (!secret) return true;

  if (!token) return false;

  const body = new URLSearchParams();
  body.append("secret", secret);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as SiteVerifyResponse;
    return data.success === true;
  } catch {
    return false;
  }
}
