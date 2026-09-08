import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120).optional(),
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
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

/** A single favorite pair token: uppercased, de-duped upstream. */
const favoritePairSchema = z.string().trim().toUpperCase().min(3).max(32);

/**
 * Tier-aware preferences validator.
 *
 *   • intervals   — PRO only (Free is pinned to 15m; the API rejects interval
 *                   changes from Free users). Optional so Free can PATCH just
 *                   favorites without sending intervals.
 *   • favoritePairs — both tiers, capped per plan (Free 3, Pro 10).
 */
export function makePreferencesSchema(plan: "free" | "pro") {
  const maxFavorites =
    plan === "pro" ? PRO_MAX_FAVORITES : FREE_MAX_FAVORITES;

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
          plan === "pro"
            ? `Pro plans can pin up to ${PRO_MAX_FAVORITES} favorites.`
            : `Free plans can pin up to ${FREE_MAX_FAVORITES} favorites. Upgrade to Pro for more.`,
      })
      .optional(),
  });
}

/** Back-compat: the Pro-capped schema (used where a static schema is needed). */
export const preferencesSchema = makePreferencesSchema("pro");

export type PreferencesInput = z.infer<typeof preferencesSchema>;
