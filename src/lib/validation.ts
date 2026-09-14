import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120).optional(),
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
  turnstileToken: z.string().min(1, "Please complete the human verification."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type CredentialsInput = z.infer<typeof credentialsSchema>;

// ---------------------------------------------------------------------------
// User analysis preferences (Phase 3).
// ---------------------------------------------------------------------------

/** Intervals a Pro user may activate on the dashboard. */
export const SELECTABLE_INTERVALS = ["5m", "15m", "30m", "1h"] as const;
export type SelectableInterval = (typeof SELECTABLE_INTERVALS)[number];

/** Max favorite symbols each tier may pin. */
export const FREE_MAX_FAVORITES = 3;
export const PRO_MAX_FAVORITES = 10;

/**
 * Per-exchange leverage cap (Binance Futures maxes out at 125x). Configurable
 * via env so a different venue / risk policy can lower it without a code change.
 */
export const MAX_LEVERAGE = (() => {
  const parsed = Number.parseInt(process.env.MAX_LEVERAGE ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 125;
})();

/** Risk:reward ratio string — `1:<positive number>` (e.g. "1:2", "1:3.5"). */
export const RR_RATIO_PATTERN = /^1:\d+(\.\d+)?$/;

/** A single favorite pair token: uppercased, de-duped upstream. */
const favoritePairSchema = z.string().trim().toUpperCase().min(3).max(32);

/** Default leverage validator: integer in [1, MAX_LEVERAGE]. */
export const leverageSchema = z
  .number()
  .int("Leverage must be a whole number.")
  .min(1, "Leverage must be at least 1.")
  .max(MAX_LEVERAGE, `Leverage cannot exceed ${MAX_LEVERAGE}.`);

/** Default risk:reward validator: matches the `1:<positive number>` pattern. */
export const rrRatioSchema = z
  .string()
  .trim()
  .regex(RR_RATIO_PATTERN, 'Risk:reward must look like "1:2" or "1:3.5".');

/**
 * Tier-aware preferences validator.
 *
 *   • intervals   — PRO/ULTIMATE only (Free is pinned to 15m; the API rejects
 *                   interval changes from Free users). Optional so Free can
 *                   PATCH just favorites/risk without sending intervals.
 *   • favoritePairs — all tiers, capped per plan (Free 3, Pro/Ultimate 10).
 *   • defaultLeverage / defaultRrRatio — all tiers (risk params are editable
 *                   regardless of plan).
 */
export function makePreferencesSchema(plan: "free" | "pro" | "ultimate") {
  // Ultimate shares the Pro favorite cap (Free stays at the lower cap).
  const maxFavorites =
    plan === "free" ? FREE_MAX_FAVORITES : PRO_MAX_FAVORITES;

  return z.object({
    intervals: z
      .array(z.enum(SELECTABLE_INTERVALS))
      .min(1, "Select at least one timeframe.")
      .max(SELECTABLE_INTERVALS.length)
      .transform((arr) => Array.from(new Set(arr)))
      .optional(),
    favoritePairs: z
      .array(favoritePairSchema)
      .transform((arr) => Array.from(new Set(arr)))
      .refine((arr) => arr.length <= maxFavorites, {
        message:
          plan === "free"
            ? `Free plans can pin up to ${FREE_MAX_FAVORITES} favorites. Upgrade to Pro for more.`
            : `Your plan can pin up to ${PRO_MAX_FAVORITES} favorites.`,
      })
      .optional(),
    defaultLeverage: leverageSchema.optional(),
    defaultRrRatio: rrRatioSchema.optional(),
  });
}

/** Back-compat: the Pro-capped schema (used where a static schema is needed). */
export const preferencesSchema = makePreferencesSchema("pro");

export type PreferencesInput = z.infer<typeof preferencesSchema>;
