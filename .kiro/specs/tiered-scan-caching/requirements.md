# Requirements — Tier-based scan caching + user profile risk parameters

Source: GitHub issue #25 (Freemius Ultimate, 1m scan, Redis tier cache, USD TP/SL).
Supersedes the "settings only" scope of #23.

## Introduction

TrendScore today runs a single ingestion/scan worker (`src/workers/market-worker.ts`) that
scans a discovered Binance Futures universe on clock-aligned candle boundaries across four
intervals (`5m/15m/30m/1h`), scores each symbol/interval with the engine
(`src/lib/market/engine.ts`), and dispatches AI analysis in two tiers:

- **Free** — one shared 15m broadcast (`analysis:broadcast:free:15m`), top 2 picks, elected
  once per 15m window via a Redis leader lock.
- **Pro** — per-symbol/interval analysis cached at `analysis:latest:{symbol}:{interval}`, plus a
  manual "Scan now" trigger (`POST /api/analysis/scan`).

Tiers are binary today: `getUserPlan()` returns `"free" | "pro"` based on a single equality check
against `PRO_PRICING_ID = 85687` (`src/lib/user-entitlement.ts`, `src/lib/freemius.ts`).

TP/SL/entry are produced either by the LLM or by the deterministic fallback
`ruleBasedAnalysis()` (`src/lib/ai/analyzer.ts`), which uses hard-coded multipliers
(`stop = 1.5×ATR`, `TP1 = 2×stopDist`, `TP2 = 3×stopDist`, entry pad `0.5×ATR`). There is **no
leverage concept anywhere** in the codebase, and TP/SL are prices, not USD amounts.

This iteration introduces a continuous 1-minute background scanner, a three-tier Redis cache
(free/pro/ultimate) fed by resampling the 1m scan, an Ultimate subscription tier, editable
per-user risk parameters (`default_leverage`, `default_rr_ratio`), and a fix so the AI signal
response returns USD-denominated TP1/TP2/SL derived from the user's profile — not hard-coded
constants. The Pro manual "Scan now" trigger is removed.

## Requirements

### Requirement 1 — Ultimate subscription tier

**User Story:** As a paying customer, I want an Ultimate tier so that I get the fastest (1m)
signal cadence and the full feature set, distinct from Free and Pro.

#### Acceptance Criteria

1. WHEN a user holds an active Freemius entitlement whose pricing id maps to plan `88832` THEN
   the system SHALL resolve their plan to `ultimate`.
2. WHEN a user holds the existing Pro entitlement (`PRO_PRICING_ID = 85687`) THEN the system
   SHALL continue to resolve their plan to `pro` unchanged.
3. WHEN a user holds no active entitlement THEN the system SHALL resolve their plan to `free`.
4. The tier type SHALL be widened from `"free" | "pro"` to `"free" | "pro" | "ultimate"`
   consistently across entitlement resolution, the WS protocol `Plan` type, and channel
   authorization.
5. The Ultimate pricing id SHALL be configurable via env
   (`NEXT_PUBLIC_FREEMIUS_ULTIMATE_PRICING_ID`) with a default of `88832`, mirroring how
   `PRO_PRICING_ID` is defined.
6. WHEN the Freemius purchase webhook / checkout sync runs for an Ultimate purchase THEN the
   entitlement SHALL upsert cleanly into `UserFsEntitlement` and resolve to `ultimate` on the
   next request. Existing Free/Pro mappings SHALL be unaffected.
7. The pricing UI (`src/components/landing/pricing.tsx`) SHALL show three tiers; any
   "Institutional" label SHALL be rendered as "Ultimate". (Note: "Institutional" does not
   currently exist in the repo, so this is additive.)

### Requirement 2 — Continuous 1-minute background scanner

**User Story:** As the platform, I want a continuous 1-minute scanner so that all tiers are
served from fresh data without any user-initiated scan.

#### Acceptance Criteria

1. The system SHALL run a scan pass on a 1-minute tick against the Binance Futures universe
   (top-movers UNION user favorites, as resolved today by `resolveUniverse()`), including
   BTCUSDT/ETHUSDT/SOLUSDT.
2. WHEN a tick runs THEN it SHALL pull the last N 1-minute candles per symbol and run the
   existing scoring engine (`analyzeSymbolInterval`) on the 1m interval.
3. The tick SHALL be idempotent: a short Redis lock SHALL prevent two overlapping ticks from
   running concurrently (single-instance today, but the lock SHALL be safe across replicas).
4. WHEN a tick fails (Binance error, engine error, Redis error) THEN the failure SHALL be logged
   and SHALL NOT prevent the next tick from running.
5. The 1m interval SHALL be added to the engine's interval set (`Interval`, `INTERVALS`) so the
   worker, WS protocol, and preferences all recognize it.
6. The scanner SHALL write a raw 1m result plus per-tier slices to Redis (see Requirement 3).

### Requirement 3 — Tier-based Redis cache

**User Story:** As a user on any tier, I want to read pre-computed results for my tier so that no
per-user recompute happens on request.

#### Acceptance Criteria

1. Cache keys SHALL follow the shape `scan:{tier}:{symbol}:{ts}` with `tier ∈ {free, pro,
   ultimate}` (plus a per-tier "latest" pointer for O(1) reads — see design).
2. A single 1m scan SHALL produce three slices from the same raw result:
   - `ultimate` — full 1m data, full TP ladder.
   - `pro` — 5m aggregation/resampling, full TP ladder.
   - `free` — 15m aggregation/resampling, reduced signal set.
3. WHEN a user requests results THEN the system SHALL read only their tier's slice; it SHALL NOT
   recompute per user.
4. Each cache entry SHALL have a TTL ≥ the scan interval (≥ 60s) plus jitter to avoid synchronized
   expiry.
5. The resampling rule SHALL be: aggregate the most recent 1m candle plus the prior N−1 1m candles
   into the target timeframe (5 candles → one 5m bar, 15 candles → one 15m bar), with
   open=first.open, close=last.close, high=max(high), low=min(low), volume=Σvolume.
6. AFTER a scan the keyspace SHALL contain `scan:free:*`, `scan:pro:*`, and `scan:ultimate:*`
   keys, and a manual fetch for a given tier SHALL return that tier's slice.

### Requirement 4 — Remove Pro manual scan

**User Story:** As a Pro user, I no longer need a "Scan now" button because results refresh
automatically.

#### Acceptance Criteria

1. The Pro "Scan now" trigger SHALL be removed from the dashboard UI
   (`src/components/dashboard/dashboard-live.tsx`).
2. The manual scan endpoint (`POST /api/analysis/scan`) and its history dependency SHALL be
   removed or disabled such that no UI path invokes it.
3. WHEN a Pro user views the dashboard THEN they SHALL see results within at most 5 minutes of the
   last 1m scan (bounded by the 5m Pro slice cadence).

### Requirement 5 — AI analysis cadence and degraded path

**User Story:** As the platform, I want AI analysis to complete within the 1-minute budget so the
Ultimate cadence holds, with a defined degraded path when it cannot.

#### Acceptance Criteria

1. AI analysis SHALL run on the 1m scan and SHALL be designed to complete within the 1-minute
   tick budget.
2. WHEN AI latency for a tick exceeds the budget THEN the system SHALL follow a degraded path:
   reuse the previous tick's cached rationale/summary and refresh ONLY the numeric fields (entry,
   TP1, TP2, SL) from the current price and the user/tier profile.
3. AI failures SHALL NOT throw; the existing rule-based fallback SHALL remain the last resort.
4. AI dispatch SHALL be bounded so one tick's analyses cannot pile up into the next tick
   (concurrency cap + per-symbol cooldown, consistent with the current orchestrator).

### Requirement 6 — User profile risk parameters

**User Story:** As a user, I want to set my default leverage and risk:reward so that signals are
tailored to how I trade.

#### Acceptance Criteria

1. The user profile SHALL expose two new persisted fields on `UserPreference`:
   - `default_leverage` — numeric, default `10`, editable, bounded per exchange (min 1, max the
     configured per-exchange cap).
   - `default_rr_ratio` — string, default `"1:2"`, validated against the pattern `1:<positive
     number>`.
2. WHEN a field is unset THEN the system SHALL apply the existing defaults (`10x`, `"1:2"`).
3. WHEN a user PATCHes an out-of-bounds leverage or malformed RR ratio THEN the API SHALL reject
   it with a validation error (Zod), consistent with the existing preferences route.
4. Already-open positions SHALL keep the leverage/RR they were opened with (values are read at
   signal-generation time, not retroactively applied).
5. The settings surface (inline on the dashboard today) SHALL let users edit both fields.

### Requirement 7 — USD-denominated TP/SL derived from profile (bug fix)

**User Story:** As a user, I want TP/SL in USD computed from my own leverage and R:R so the
numbers reflect my risk, not hard-coded constants.

#### Acceptance Criteria

1. The signal response SHALL include: entry zone (price), TP1 (USD), TP2 (USD), and Stop Loss
   (USD).
2. All four numbers SHALL be derived from the requesting user's `default_leverage` and
   `default_rr_ratio` at signal-generation/read time — NOT from the hard-coded `1.5 / 0.5 / 2 / 3`
   multipliers in `ruleBasedAnalysis()`.
3. WHEN a user sets a non-default leverage THEN the USD TP/SL numbers SHALL change accordingly and
   be verifiable.
4. WHEN a user has `default_leverage = 25` and `default_rr_ratio = "1:3"` THEN the returned TP/SL
   SHALL match an independent manual recompute (E2E acceptance test).
5. The USD amounts SHALL be computed against the tier demo balance already defined in a prior
   issue (Free $1k / Pro $10k / Ultimate $100k) as the position sizing base; the balance source
   SHALL be pluggable so a future real-balance integration can replace it.

## Out of Scope

- Telegram / webhook delivery changes.
- Marketing pages (blog, FAQ).
- Defining the tier demo balances themselves (covered by a previous issue) — this spec only
  consumes them.

## Open Questions (to confirm during design/implementation)

1. Resampling rule for pro/free — proposed rule captured in Req 3.5; confirm N and alignment.
2. Redis key naming + TTL — proposed in Req 3.1/3.4 and the design; confirm the "latest" pointer
   approach.
3. Degraded-AI path — proposed in Req 5.2; confirm the numeric-only refresh is acceptable.
4. Cross-cutting risks to track: Binance REST rate limits at 1m cadence, Redis memory growth from
   per-ts keys, and multi-region latency for the AI call. Mitigations proposed in design.
