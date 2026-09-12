# Design — Tier-based scan caching + user profile risk parameters

This design maps issue #25 onto the existing TrendScore architecture. It reuses the current
worker, engine, Redis client, Freemius/entitlement layer, WS gateway, and preferences plumbing
rather than introducing new infrastructure.

## Existing architecture (as-is)

Three Node processes talk only through Redis (Pub/Sub + keys) and Postgres (Prisma):

- **Web app** (`next`) — serves the dashboard + API routes.
- **market-worker** (`tsx src/workers/market-worker.ts`) — Binance ingestion, clock-aligned scans
  on `5m/15m/30m/1h`, engine scoring, tiered AI dispatch. Overlap guarded by an in-process
  `scanInFlight` flag + `pendingScanIntervals` queue.
- **ws-gateway** (`tsx src/workers/ws-gateway.ts`) — read-side fan-out of Redis Pub/Sub to browser
  sockets, tier-gated via `authorizeChannel`.

Key current facts this design builds on:

- Tier resolution: `getUserPlan(userId)` in `src/lib/user-entitlement.ts` → equality against
  `PRO_PRICING_ID` (`src/lib/freemius.ts`). Binary today.
- Intervals: `Interval = "5m"|"15m"|"30m"|"1h"`, `INTERVALS` in `src/lib/market/types.ts`.
- Scan pass: `scanMarket()` in `src/lib/market/scan.ts` (shared by worker + manual route).
- AI: `generateAnalysis()` / `ruleBasedAnalysis()` in `src/lib/ai/analyzer.ts`; tier dispatch in
  `src/lib/ai/orchestrator.ts`; Redis storage in `src/lib/ai/store.ts`.
- Redis client: single shared `ioredis` in `src/lib/redis.ts`, null-safe (degrades when
  `REDIS_URL` unset).
- Preferences: `UserPreference` model + `src/lib/user-preferences.ts` + `PATCH
  /api/user/preferences` with tier-aware Zod validation (`src/lib/validation.ts`).
- Feed: `GET /api/analysis/feed` branches on plan; dashboard client is
  `src/components/dashboard/dashboard-live.tsx`.
- Manual scan: `POST /api/analysis/scan` + `/api/analysis/scan/history`, button rendered only for
  Pro in `dashboard-live.tsx`.

## Target architecture (to-be)

```
                 ┌─────────────────────────── every 60s ───────────────────────────┐
                 │                                                                   │
   Binance REST/WS ──► market-worker ──► engine (1m scan) ──► RAW result             │
                                                │                                    │
                                                ├─► resample → 5m slice (pro)        │
                                                ├─► resample → 15m slice (free)      │
                                                └─► 1m slice (ultimate)              │
                                                        │                            │
                                     write scan:{tier}:{symbol}:{ts} + scan:{tier}:{symbol}:latest
                                                        │                            │
                                     AI enrich (bounded, degraded-path fallback)     │
                                                        │                            │
   Browser ──► /api/analysis/feed ──► read scan:{tier}:* for caller's tier ──────────┘
            └─► ws-gateway fan-out (tier-gated), USD TP/SL computed from user profile at read time
```

The 1m scan becomes the single source of truth. Pro (5m) and Free (15m) are **derived** by
resampling, so there is exactly one engine run per symbol per minute and no per-user recompute.

## Components and changes

### C1. Tier model (`free | pro | ultimate`)

- `src/lib/freemius.ts`: add
  `export const ULTIMATE_PRICING_ID = process.env.NEXT_PUBLIC_FREEMIUS_ULTIMATE_PRICING_ID ?? "88832";`
- `src/lib/user-entitlement.ts`: widen `UserPlan` to `"free" | "pro" | "ultimate"`; update
  `getUserPlan()` to map `fsPricingId === ULTIMATE_PRICING_ID → "ultimate"`, then
  `=== PRO_PRICING_ID → "pro"`, else `"free"`. (If a user somehow holds both, Ultimate wins.)
- `src/lib/ws/protocol.ts`: widen `Plan` to include `"ultimate"`; extend `allowedIntervalsForPlan`
  (Ultimate → `["1m","5m","15m","30m","1h"]`, Pro → `["5m","15m","30m","1h"]`, Free → `["15m"]`)
  and `authorizeChannel` so Ultimate may subscribe to 1m channels.
- Rationale: preserves the single-equality style; entitlement lookup already returns any active
  subscription so no query change is needed.

### C2. 1m interval + continuous scanner

- `src/lib/market/types.ts`: add `"1m"` to `Interval` and `INTERVALS`. Add `INTERVAL_MS["1m"] =
  60_000` where interval→ms maps live (worker + config).
- `src/workers/market-worker.ts`:
  - Register a 1m aligned scan via the existing `scheduleAlignedScan("1m")` path (it already
    computes the next boundary + `SCAN_ALIGN_GRACE_MS`). This gives a 60s cadence "for free" using
    the current clock-aligned scheduler.
  - Keep the existing `scanInFlight`/`pendingScanIntervals` overlap guard; add a **distributed
    Redis lock** (`SET scan:lock:1m <id> NX PX 55000`) around the 1m pass so replicas don't double
    up. Release in `finally`; the short TTL self-heals a crashed holder. A failed lock acquisition
    simply skips the tick (next tick retries) — satisfies "failed tick must not break the next
    tick".
  - Wrap the 1m pass body in try/catch that logs and returns, never rethrows.
- `src/lib/market/scan.ts`: `scanMarket()` already accepts `intervals`. The 1m pass calls it with
  `intervals: ["1m"]`. After producing candidates it invokes the new slicing step (C3).

### C3. Tier slicing + resampling

- New module `src/lib/market/resample.ts`:
  - `resampleKlines(klines1m: Kline[], factor: number): Kline` — aggregates the most recent
    `factor` 1m candles into one bar: `open=first.open, close=last.close, high=max, low=min,
    volume=sum, openTime=first.openTime, closeTime=last.closeTime`. `factor=5` → 5m, `factor=15` →
    15m. Requirement 3.5.
  - Guards: if fewer than `factor` candles, aggregate what exists (partial bar) and mark it.
- New module `src/lib/market/tier-cache.ts` (co-located with `redis-pipeline.ts`):
  - `tierScanKey(tier, symbol, ts)` → `scan:{tier}:{symbol}:{ts}`.
  - `tierLatestKey(tier, symbol)` → `scan:{tier}:{symbol}:latest` (pointer for O(1) reads; avoids a
    SCAN on every feed request).
  - `writeTierSlices({ symbol, ts, ultimate, pro, free })` — pipelines `SET` for each tier's
    `:{ts}` key and overwrites the `:latest` key, each with `EX = TIER_TTL_SEC[tier] +
    jitter(0..15s)`.
  - TTLs: `ultimate` 90s, `pro` 360s, `free` 960s (≥ one slice interval each, Req 3.4).
  - `readTierSlice(tier, symbol)` reads `:latest`; `readTierSlices(tier, symbols)` MGETs latest
    keys. Reads are per-tier only (Req 3.3).
  - Slice payload shape: `{ tier, symbol, interval, ts, candidate, indicators, ai }` where `free`
    carries a **reduced signal set** (omit the full TP ladder / detailed key factors; keep
    direction, score, entry, single TP + SL).
- The 1m scan writes all three slices from one raw result. Ultimate = raw 1m; Pro = engine run on
  resampled 5m bar; Free = engine run on resampled 15m bar (reduced fields).

### C4. AI enrichment: cadence + degraded path

- `src/lib/ai/orchestrator.ts`:
  - Add a bounded dispatch (e.g. `p-limit`-style manual concurrency cap already used by the scan's
    `CONCURRENCY = 12`) so AI calls for a tick can't overrun into the next tick.
  - Add `generateWithBudget(ctx, budgetMs)`: race `generateAnalysis(ctx)` against a
    `budgetMs` timer. On timeout → **degraded path**: load the previous cached analysis for the
    symbol/interval, keep its `summary`/`keyFactors`/`sentiment`, and recompute only the numeric
    fields (entry/TP/SL) from the current price + profile (see C5). Mark `source: "degraded"`.
  - The `AIAnalysisOutput`/`StoredAnalysis` `source` union widens to `"llm" | "fallback" |
    "degraded"`.
- Latency budget: `AI_TIMEOUT_MS` already 15s per model. For the 1m tick, cap total AI work with a
  per-tick budget (`AI_TICK_BUDGET_MS`, default ~45s) and per-symbol timeout so the numeric path
  always resolves inside 60s even under LLM slowness.

### C5. USD TP/SL from profile (the bug fix)

- New pure module `src/lib/ai/risk.ts`:
  - `parseRrRatio("1:3") → 3` (reward multiple); validated, defaults to `2`.
  - `computeUsdLevels({ entryPrice, direction, atrRatioPct, leverage, rrReward, balanceUsd }) → {
    entryZone: [number, number], stopLossPrice, tp1Price, tp2Price, stopLossUsd, tp1Usd, tp2Usd }`.
    - Stop distance uses ATR% as the volatility unit (same basis as today) but the **R:R and
      position size come from the profile**, not fixed `2/3` multipliers:
      - `stopDist = entryPrice * max(atrRatioPct, floor)/100 * K` (K configurable).
      - `tp1 = entry ± stopDist * rrReward`, `tp2 = entry ± stopDist * (rrReward + 1)`.
      - Position notional = `balanceUsd * leverage`; qty = notional / entryPrice.
      - `stopLossUsd = |entry − stopLoss| * qty`, `tp1Usd = |tp1 − entry| * qty`, likewise tp2.
  - Deterministic and unit-testable — this is what the E2E test (25x, "1:3") recomputes against.
- Wire-in points:
  - `ruleBasedAnalysis()` in `analyzer.ts` stops using the hard-coded `1.5/0.5/2/3` constants for
    the ladder shape; it delegates ladder geometry to `computeUsdLevels` with a default profile.
  - USD amounts are **read-time, per-user**: the cached slice stores prices + the candidate's
    `atrRatioPct`; when a user reads the feed, `/api/analysis/feed` (and the ws-gateway on
    delivery) computes USD TP/SL using *that user's* `default_leverage`/`default_rr_ratio` and
    their tier's demo balance. This keeps the cache user-agnostic (Req 3.3) while making the USD
    numbers per-user (Req 7.2).
- Balance source: `src/lib/ai/balances.ts` → `demoBalanceForTier(tier)` returning `{ free: 1000,
  pro: 10000, ultimate: 100000 }`, pluggable behind an interface for future real balances (Req
  7.5).

### C6. Profile fields

- `prisma/schema.prisma` `UserPreference`: add
  `defaultLeverage Int @default(10)` and `defaultRrRatio String @default("1:2")` (DB column names
  `default_leverage` / `default_rr_ratio` via `@map`). New migration.
- `src/lib/user-preferences.ts`: include the two fields in read/upsert; defaults applied when no
  row.
- `src/lib/validation.ts`: extend the preferences Zod schema — `defaultLeverage` int in
  `[1, MAX_LEVERAGE]` (env `MAX_LEVERAGE`, default 125 for Binance Futures), `defaultRrRatio`
  matching `^1:\d+(\.\d+)?$`.
- `src/app/api/user/preferences/route.ts`: accept/merge the new fields in PATCH; return them in
  GET. Editing risk params is allowed for all tiers (unlike interval selection).
- Dashboard settings UI: add a small "Risk defaults" form (leverage input + R:R select) next to
  the existing `TimeframeSelector`/`FavoritesManager` in `dashboard-live.tsx`.

### C7. Feed + dashboard read path

- `GET /api/analysis/feed`:
  - Resolve `plan` (now 3-valued) and the user's risk profile.
  - Read the caller's tier slice via `readTierSlices(plan, symbols)` instead of the current
    per-tier ad-hoc reads. Compute USD TP/SL per row using the user's profile + tier balance.
  - Free keeps the reduced signal set + locked-timeframe placeholders; Ultimate exposes 1m.
- Dashboard `dashboard-live.tsx`: remove the "Scan now" button + `handleManualScan` +
  `loadHistory`/`ScanHistory` usage; render Ultimate 1m timeframe when `plan === "ultimate"`.

### C8. Remove manual scan

- Delete/disable `src/app/api/analysis/scan/route.ts` and `src/app/api/analysis/scan/history`
  (and the `pushScanHistory` pipeline entry if unused elsewhere). Remove UI references.

### C9. Pricing UI

- `src/components/landing/pricing.tsx`: extend the `PLANS` array to three entries (Free / Pro /
  Ultimate). Ensure any "Institutional" copy (currently absent) renders as "Ultimate".

## Data model

New/changed Prisma fields (migration `add_user_risk_params`):

```prisma
model UserPreference {
  // ...existing...
  defaultLeverage Int    @default(10)  @map("default_leverage")
  defaultRrRatio  String @default("1:2") @map("default_rr_ratio")
}
```

No schema change for tiers — the existing `UserFsEntitlement.fsPricingId` already carries enough
to resolve Ultimate via the new pricing-id constant.

## Redis schema

| Key | Purpose | TTL |
|-----|---------|-----|
| `scan:ultimate:{symbol}:{ts}` | 1m slice (full TP ladder) | 90s + jitter |
| `scan:pro:{symbol}:{ts}` | 5m resampled slice (full ladder) | 360s + jitter |
| `scan:free:{symbol}:{ts}` | 15m resampled slice (reduced) | 960s + jitter |
| `scan:{tier}:{symbol}:latest` | O(1) pointer to newest slice per tier | same as slice |
| `scan:lock:1m` | distributed 1m-tick lock (`SET NX PX 55000`) | 55s |
| (existing) `analysis:latest:{symbol}:{interval}` | prior AI analysis for degraded reuse | 24h |

`{ts}` = the 1m boundary epoch-ms of the scan. The `:latest` pointer is the primary read path;
`:{ts}` keys give short-lived history and let the acceptance test assert `scan:free:*` /
`scan:pro:*` / `scan:ultimate:*` exist.

## Worker / cron topology

- No new process. The existing single `market-worker` gains a 1m aligned scan alongside its
  current intervals, guarded by the distributed lock.
- `ws-gateway` unchanged in topology; only the `Plan`/authorization types widen to admit Ultimate
  + 1m channels.
- Multi-replica safety: the 1m Redis lock ensures one scanner runs the tick; the existing Free
  cycle-leader lock is unchanged.

## Latency budget (1-minute tick)

| Stage | Target |
|-------|--------|
| Acquire lock + resolve universe (cached) | < 0.5s |
| REST refresh 1m candles (bounded, CONCURRENCY 12) | ≤ 15s |
| Engine scoring (all symbols × 1m) | ≤ 5s |
| Resample + write tier slices (pipelined) | ≤ 2s |
| AI enrichment (bounded, budgeted, degraded-path) | ≤ 45s total, per-symbol timeout |
| **Total** | **< 60s** with headroom; degraded path guarantees numeric refresh regardless |

If AI can't finish for a symbol within budget → degraded path (numeric-only refresh from cached
rationale), so the tick always completes inside the minute.

## Cross-cutting risks & mitigations

- **Binance REST rate limits at 1m cadence** — reuse the WS stream where reachable
  (`MARKET_DATA_MODE`), keep the bounded `CONCURRENCY=12` refresh, and cap the universe
  (`MAX_TRACKED_SYMBOLS`, default 60). Consider batching klines and backing off on 429/418.
- **Redis memory growth from per-`{ts}` keys** — short TTLs (90/360/960s) + `:latest` pointer for
  reads means the `:{ts}` history is small and self-expiring. No unbounded lists.
- **Multi-region AI latency** — the per-symbol timeout + degraded path bound worst case; numeric
  fields never depend on the LLM.
- **Cache/user coupling** — USD TP/SL computed at read time keeps the cache user-agnostic; the E2E
  test verifies per-user correctness.

## Testing strategy

- **Unit** (`tsx`, existing `scripts/` pattern or a runner):
  - `resampleKlines` — 5×1m → one 5m bar (OHLCV correctness); partial-window handling.
  - `parseRrRatio` — valid/invalid strings.
  - `computeUsdLevels` — deterministic prices + USD amounts; leverage/RR sensitivity.
  - `getUserPlan` — Ultimate/Pro/Free mapping incl. both-entitlements precedence.
- **Integration:**
  - 1m scan writes `scan:free:* / scan:pro:* / scan:ultimate:*` and `:latest` pointers with TTLs.
  - Distributed lock prevents overlap; a thrown tick doesn't block the next.
  - Degraded path reuses cached rationale and refreshes numerics on simulated AI timeout.
- **E2E acceptance (Req 7.4):** user with `default_leverage=25`, `default_rr_ratio="1:3"` →
  `/api/analysis/feed` TP1/TP2/SL (USD) equal an independent recompute via `computeUsdLevels`.
- **Regression:** existing Free/Pro flows unchanged; preferences PATCH still tier-gates intervals.

## Verification approach

- `npm run build` (runs `prisma generate` + `next build`) and `npm run worker:typecheck` after
  type/schema changes.
- `npm run db:migrate:dev` for the new migration; confirm defaults apply on existing rows.
- Run the 1m worker locally with `REDIS_URL` set and inspect keys
  (`redis-cli keys 'scan:*'`).
