// ---------------------------------------------------------------------------
// User analysis preferences helper (Phase 3).
//
// Thin data-access layer over the `UserPreference` table. Free users always
// resolve to the default (15m only) — the API layer enforces that Free users
// cannot mutate these; this module just reads/writes rows.
// ---------------------------------------------------------------------------

import type { UserPreference } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  SELECTABLE_INTERVALS,
  type SelectableInterval,
} from "@/lib/validation";

/** Default preferences for users without a stored row (matches schema default). */
export const DEFAULT_INTERVALS: SelectableInterval[] = ["15m"];

export interface ResolvedPreferences {
  intervals: SelectableInterval[];
  favoritePairs: string[];
}

/** Narrows arbitrary stored strings back to the known selectable interval set. */
function coerceIntervals(values: string[]): SelectableInterval[] {
  const allowed = new Set<string>(SELECTABLE_INTERVALS);
  const out = values.filter((v): v is SelectableInterval => allowed.has(v));
  return out.length ? Array.from(new Set(out)) : [...DEFAULT_INTERVALS];
}

/**
 * Reads a user's preferences, returning defaults when no row exists yet.
 */
export async function getUserPreferences(
  userId: string,
): Promise<ResolvedPreferences> {
  const row = await prisma.userPreference.findUnique({ where: { userId } });
  if (!row) {
    return { intervals: [...DEFAULT_INTERVALS], favoritePairs: [] };
  }
  return {
    intervals: coerceIntervals(row.intervals),
    favoritePairs: row.favoritePairs,
  };
}

/**
 * Collects the distinct set of favorite pairs across ALL users. The worker
 * unions this with the top-movers universe so any symbol a user has favorited
 * is always streamed/scanned, even if it isn't currently a top mover.
 *
 * Returns UPPERCASE symbols, de-duplicated. Safe to call periodically.
 */
export async function getAllFavoritePairs(): Promise<string[]> {
  const rows = await prisma.userPreference.findMany({
    where: { NOT: { favoritePairs: { isEmpty: true } } },
    select: { favoritePairs: true },
  });
  const set = new Set<string>();
  for (const row of rows) {
    for (const pair of row.favoritePairs) {
      const s = pair.trim().toUpperCase();
      if (s) set.add(s);
    }
  }
  return Array.from(set);
}

/**
 * Creates or updates a user's preferences (upsert on the unique userId).
 * Returns the persisted row.
 */
export async function upsertUserPreferences(
  userId: string,
  data: { intervals: SelectableInterval[]; favoritePairs?: string[] },
): Promise<UserPreference> {
  const favoritePairs = data.favoritePairs ?? [];
  return prisma.userPreference.upsert({
    where: { userId },
    create: { userId, intervals: data.intervals, favoritePairs },
    update: { intervals: data.intervals, favoritePairs },
  });
}
