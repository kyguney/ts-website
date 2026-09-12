# Implementation Plan — Tier-based scan caching + user profile risk parameters

Phased, incremental tasks. Each references the requirements it satisfies. Tasks are ordered so the
system stays buildable at every step (types → data → cache → AI → API/UI → tests).

## Phase 1 — Foundations: tiers + 1m interval

- [x] 1. Add the Ultimate tier to the entitlement/plan model
  - Add `ULTIMATE_PRICING_ID` (env `NEXT_PUBLIC_FREEMIUS_ULTIMATE_PRICING_ID`, default `88832`) in
    `src/lib/freemius.ts`.
  - Widen `UserPlan` to `"free" | "pro" | "ultimate"` and update `getUserPlan()` in
    `src/lib/user-entitlement.ts` (Ultimate checked before Pro; else Free).
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6_

- [x] 2. Widen the WS protocol plan/authorization for Ultimate + 1m
  - Widen `Plan` in `src/lib/ws/protocol.ts`; update `allowedIntervalsForPlan` and
    `authorizeChannel` so Ultimate may subscribe to 1m channels; add `"1m"` to
    `SUPPORTED_INTERVALS`.
  - _Requirements: 1.4, 2.5_

- [x] 3. Add the 1m interval to the engine interval set
  - Add `"1m"` to `Interval` and `INTERVALS` in `src/lib/market/types.ts`; add `INTERVAL_MS["1m"]`
    wherever the interval→ms map exists (`market-worker.ts` and any config).
  - Run `npm run worker:typecheck` to catch exhaustiveness breaks.
  - _Requirements: 2.5_

## Phase 2 — User profile risk parameters

- [x] 4. Add `default_leverage` / `default_rr_ratio` to the data model
  - Extend `UserPreference` in `prisma/schema.prisma` with `defaultLeverage Int @default(10)
    @map("default_leverage")` and `defaultRrRatio String @default("1:2") @map("default_rr_ratio")`.
  - Create migration (`npm run db:migrate:dev`, name `add_user_risk_params`).
  - _Requirements: 6.1, 6.2_

- [x] 5. Read/write + validate the new profile fields
  - Include both fields in `src/lib/user-preferences.ts` read/upsert (defaults when no row).
  - Extend the Zod schema in `src/lib/validation.ts`: leverage int `[1, MAX_LEVERAGE]` (env
    default 125), RR ratio matching `^1:\d+(\.\d+)?$`.
  - Update `GET`/`PATCH` in `src/app/api/user/preferences/route.ts` to return/merge the fields
    (editable for all tiers).
  - _Requirements: 6.1, 6.3, 6.5_

## Phase 3 — Risk math + USD TP/SL (bug fix)

- [x] 6. Implement deterministic risk math
  - New `src/lib/ai/risk.ts`: `parseRrRatio()` and `computeUsdLevels()` (prices + USD amounts from
    entry, direction, ATR%, leverage, RR reward, balance) per design C5.
  - New `src/lib/ai/balances.ts`: `demoBalanceForTier(tier)` behind a pluggable interface.
  - _Requirements: 7.1, 7.2, 7.5_

- [x] 7. Replace hard-coded TP/SL constants
  - Refactor `ruleBasedAnalysis()` in `src/lib/ai/analyzer.ts` to delegate ladder geometry to
    `computeUsdLevels` (drop the fixed `1.5 / 0.5 / 2 / 3` multipliers as the source of the ladder
    shape).
  - Keep the cached slice user-agnostic: store prices + `atrRatioPct`; compute USD per-user at read
    time.
  - _Requirements: 7.2, 3.3_

## Phase 4 — Continuous 1m scanner + tier cache

- [x] 8. Implement resampling
  - New `src/lib/market/resample.ts`: `resampleKlines(klines1m, factor)` (5→5m, 15→15m) with
    OHLCV aggregation and partial-window handling.
  - _Requirements: 3.5_

- [x] 9. Implement the tier cache layer
  - New `src/lib/market/tier-cache.ts`: `tierScanKey`, `tierLatestKey`, `writeTierSlices`,
    `readTierSlice`/`readTierSlices`, per-tier TTLs (90/360/960s) + jitter, reduced-field free
    slice shape.
  - _Requirements: 3.1, 3.2, 3.4, 3.6_

- [x] 10. Wire the 1m scan into the worker with a distributed lock
  - Add a 1m aligned scan via `scheduleAlignedScan("1m")` in `src/workers/market-worker.ts`.
  - Add a Redis lock (`SET scan:lock:1m <id> NX PX 55000`) around the 1m pass; release in
    `finally`; skip tick on failed acquisition.
  - Wrap the 1m pass so a failure logs and never blocks the next tick.
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 11. Produce and persist tier slices from the 1m scan
  - In `src/lib/market/scan.ts` (or a post-scan step), for each symbol build ultimate (raw 1m),
    pro (engine on resampled 5m), free (engine on resampled 15m, reduced) slices and call
    `writeTierSlices`.
  - _Requirements: 2.6, 3.2, 3.6_

## Phase 5 — AI cadence + degraded path

- [x] 12. Bound AI dispatch and add the degraded path
  - In `src/lib/ai/orchestrator.ts`: add per-tick concurrency cap + `generateWithBudget(ctx,
    budgetMs)` that on timeout reuses the previous cached rationale and refreshes only numeric
    fields via `computeUsdLevels`.
  - Widen the `source` union to include `"degraded"` in `analyzer.ts`/`store.ts`.
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

## Phase 6 — Read path, UI, pricing, removal

- [x] 13. Serve tier slices with per-user USD TP/SL
  - Update `GET /api/analysis/feed` to read the caller's tier slice via `readTierSlices` and
    compute USD TP1/TP2/SL from the user's profile + tier balance; Free reduced set + locked
    timeframes; Ultimate exposes 1m.
  - _Requirements: 3.3, 7.1, 7.2, 7.3_

- [x] 14. Remove the Pro manual scan
  - Remove the "Scan now" button, `handleManualScan`, and `ScanHistory` usage from
    `src/components/dashboard/dashboard-live.tsx`; delete/disable
    `src/app/api/analysis/scan/route.ts` and `scan/history`.
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 15. Ultimate in the dashboard + pricing page
  - Render the 1m timeframe for `plan === "ultimate"` in the dashboard; add a "Risk defaults" form
    (leverage + R:R).
  - Extend `PLANS` in `src/components/landing/pricing.tsx` to three tiers; render any
    "Institutional" copy as "Ultimate".
  - _Requirements: 1.7, 6.5_

## Phase 7 — Tests & verification

- [x] 16. Unit tests
  - `resampleKlines`, `parseRrRatio`, `computeUsdLevels`, `getUserPlan` tier mapping.
  - _Requirements: 3.5, 6.3, 7.2, 1.1–1.3_

- [x] 17. Integration tests
  - 1m scan writes `scan:free:* / scan:pro:* / scan:ultimate:*` + `:latest` with TTLs; lock
    prevents overlap; thrown tick doesn't block the next; degraded path refreshes numerics on
    simulated timeout.
  - _Requirements: 2.3, 2.4, 3.6, 5.2_

- [x] 18. E2E acceptance test
  - User with `default_leverage=25`, `default_rr_ratio="1:3"` → feed TP1/TP2/SL (USD) match an
    independent `computeUsdLevels` recompute; changing leverage changes the numbers.
  - _Requirements: 7.3, 7.4_

- [x] 19. Full verification
  - `npm run build`, `npm run worker:typecheck`, `npm run db:deploy`; run the 1m worker locally
    with `REDIS_URL` and confirm keys via `redis-cli keys 'scan:*'`.
  - Confirm existing Free/Pro flows unchanged.
  - _Requirements: 1.6, 4.3_
