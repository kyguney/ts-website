import { Freemius } from "@freemius/sdk";

// Lazily-instantiated Freemius SDK client (server-side only — uses secret keys).
//
// We must NOT construct the client at module load: Next.js evaluates route
// modules during `next build` ("collect page data"), where the FREEMIUS_*
// secrets are not present (they are runtime-only in Docker/Coolify). Building
// eagerly would throw "Unsupported FSId type: undefined". Constructing on first
// use defers that to request time, when the env vars exist.
let _freemius: Freemius | null = null;

export function getFreemius(): Freemius {
  if (!_freemius) {
    _freemius = new Freemius({
      productId: process.env.FREEMIUS_PRODUCT_ID!,
      apiKey: process.env.FREEMIUS_API_KEY!,
      secretKey: process.env.FREEMIUS_SECRET_KEY!,
      publicKey: process.env.FREEMIUS_PUBLIC_KEY!,
    });
  }
  return _freemius;
}

/** The Pro plan's Freemius pricing id — used to gate Pro-only features. */
export const PRO_PRICING_ID =
  process.env.NEXT_PUBLIC_FREEMIUS_PRO_PRICING_ID ?? "85687";

/** The Ultimate plan's Freemius pricing id — used to gate Ultimate-only features. */
export const ULTIMATE_PRICING_ID =
  process.env.NEXT_PUBLIC_FREEMIUS_ULTIMATE_PRICING_ID ?? "88832";

/**
 * Whether checkout should run in Freemius SANDBOX (test) mode.
 *
 * Controlled by FREEMIUS_SANDBOX so you can test with fake cards on a live
 * (NODE_ENV=production) deploy, then flip it off for real launch:
 *   FREEMIUS_SANDBOX="true"  -> test payments (card 4242 4242 4242 4242)
 *   unset / "false"          -> live payments
 * Falls back to sandbox automatically in non-production (local dev).
 */
export const IS_FREEMIUS_SANDBOX =
  process.env.FREEMIUS_SANDBOX === "true" ||
  (process.env.FREEMIUS_SANDBOX !== "false" &&
    process.env.NODE_ENV !== "production");
