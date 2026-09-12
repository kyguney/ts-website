# Design Document

## Overview

This spec resolves three related dashboard concerns, all grounded in the existing
`DashboardLive` client component and the tiered feed built by the completed
`tiered-scan-caching` spec:

- **Concern A — Auto-refreshing signals (bug fix).** `DashboardLive` fetches the
  feed once on mount and then never re-fetches. After mount, rows only change when
  the live socket pushes a new above-threshold AI analysis (`latestSignals`) or a
  new `free_broadcast`; the per-tier slice rows and the per-user `usd` envelope are
  never re-read. The feed therefore goes stale. This design adds a refresh
  mechanism: a **scan-heartbeat–driven refresh** (primary, tier-aligned by
  construction) plus a **modest safety-net poll** (fallback, socket-independent).

- **Concern B — Remove the timeframe tabs.** The `TimeframeSelector` pill row is
  removed for every tier. Each tier is served exactly one interval (Free 15m,
  Pro 5m, Ultimate 1m), so the client's `active` state and its preference-PATCH
  path collapse into a derived `servedInterval` constant. A read-only last-scan
  indicator is retained.

- **Concern C — Avatar settings menu.** A net-new `UserMenu` avatar dropdown holds
  the Risk defaults form, the Favorites manager, an Upgrade link (Free), and Sign
  out. The Risk defaults and Favorites controls move out of the dashboard body.
  Because favorites state and the row star must stay consistent (Req 8) and a
  favorites change must trigger a Feed_Refresh (Req 8.4), the menu is **co-located
  inside `DashboardLive`'s own header row** rather than the global server layout —
  the simplest way to avoid cross-subtree state plumbing (see Concern C below).

The scope is strictly the nine requirements. No unrelated redesign, no new data
model, no new API endpoint.

## Architecture

### Current data flow (before)

```
page.tsx (server)
  └─ DashboardLive (client)
       ├─ loadFeed()  ── once on mount ──►  GET /api/analysis/feed
       ├─ useMarketSocket() ── ticks / latestSignals / freeSignals /
       │                        latestBroadcast / scanStatus
       ├─ TimeframeSelector  (active + handleSelect + persistInterval PATCH)
       ├─ FavoritesManager   (in body)
       ├─ RiskDefaults        (in body)
       └─ LiveSignalsTable    (rows filtered by `active`)
layout.tsx (server header)  ── BrandLogo, nav, PRO/FREE badge, email, SignOutButton
```

### Target data flow (after)

```
page.tsx (server)  ── passes plan + preferences ──►
  └─ DashboardLive (client)
       ├─ servedInterval = SERVED_INTERVAL[plan]        (Concern B: constant)
       ├─ loadFeed()  (useCallback, unchanged read path)
       │     ▲ initial (mount)
       │     ▲ heartbeat-driven  (scanStatus completed for servedInterval)  ── Req 1.2 / 2.x
       │     ▲ safety-net poll   (setInterval @ REFRESH_MS[plan])           ── Req 1.1 / 2.4
       │
       ├─ useMarketSocket()  (ticks / latestSignals / freeSignals /
       │                       latestBroadcast / scanStatus)
       ├─ header row:
       │     ├─ read-only "Last scan" pill for servedInterval  (Req 3.6)
       │     ├─ Live/Connecting status pill
       │     └─ UserMenu (client)                               ── Concern C
       │           ├─ avatar trigger (initials)  → DropdownMenu
       │           ├─ RiskDefaults  (moved from body)           ── Req 6
       │           ├─ FavoritesManager (moved from body)        ── Req 7
       │           ├─ Upgrade link (Free only)                  ── Req 5.4
       │           └─ Sign out                                  ── Req 5.3/5.5
       └─ LiveSignalsTable  (rows filtered by servedInterval)   ── Req 3.3/3.4/3.5

layout.tsx (server header)  ── badge fixed to handle "ultimate"  (small correctness fix)
```

The layout's global header keeps BrandLogo, nav, the plan badge, and email. The
existing `SignOutButton` in the layout may remain (it is harmless and still valid);
the `UserMenu` inside `DashboardLive` carries the settings + a second Sign out, per
the Option 1 decision below.

### Why the refresh problem exists (root cause, for Req 1)

`loadFeed` is wrapped in `useCallback([indexUsd])` and invoked from a single
`useEffect(() => void loadFeed(), [loadFeed])`. `indexUsd` is stable, so the effect
runs exactly once. There is no `setInterval` and no heartbeat-triggered refetch.
The socket merge effects only *add/replace* rows keyed by `symbol:interval`; they
never re-read the tier slice or the USD envelope. Hence rows, USD amounts, and
scan-time pills freeze after the first load.

## Components and Interfaces

### `SERVED_INTERVAL` and `REFRESH_MS` (new constants, in `dashboard-live.tsx`)

```ts
// The single interval each tier is served (Concern B).
const SERVED_INTERVAL = {
  free: "15m",
  pro: "5m",
  ultimate: "1m",
} as const satisfies Record<DashboardLiveProps["plan"], DisplayInterval>;

// Safety-net poll cadence per tier (ms). Deliberately much shorter than a full
// candle period so a slow/absent heartbeat still refreshes the cheap feed read.
const REFRESH_MS = {
  free: 60_000,      // 60s
  pro: 30_000,       // 30s
  ultimate: 15_000,  // 15s
} as const satisfies Record<DashboardLiveProps["plan"], number>;
```

`DisplayInterval` is currently exported from `timeframe-selector.tsx`. Since that
file is deleted (Concern B), `DisplayInterval` is relocated inline into
`dashboard-live.tsx`:

```ts
// Relocated from the deleted timeframe-selector. "1m" is Ultimate-only and is
// not a user-selectable preference interval.
type DisplayInterval = SelectableInterval | "1m";
```

The `FeedFullResponse.interval` field (typed `DisplayInterval` today) continues to
use this relocated type — no functional change.

### `DashboardLive` (modified) — `src/components/dashboard/dashboard-live.tsx`

Props are unchanged:

```ts
export interface DashboardLiveProps {
  plan: "free" | "pro" | "ultimate";
  initialIntervals: SelectableInterval[]; // retained for back-compat; no longer drives UI
  initialFavorites: string[];
  initialLeverage: number;
  initialRrRatio: string;
}
```

State changes:

- **Removed:** `active` state + `setActive`, `handleSelect`, `handleLockedClick`,
  `persistInterval`, `savingPref`. Replaced by the `servedInterval` constant:
  ```ts
  const servedInterval = SERVED_INTERVAL[plan]; // DisplayInterval
  ```
- **Kept:** `analyses`, `usdByKey`, `favorites`, `loadingFeed`, `freeFavoriteRows`,
  `scanTimes`, `nowTick`, `selected`, `selectedUsd`, `upgradeOpen`, `upgradeReason`.
- All prior uses of `active` become `servedInterval` (channel subscription, live-
  tick interval, rows filter `a.interval === servedInterval`, the retained last-
  scan indicator).

New/changed effects (detailed under "Refresh mechanism" below):

- `loadFeed` — unchanged body and signature (`useCallback` returning `Promise<void>`).
- **Safety-net poll effect** — `setInterval(loadFeed, REFRESH_MS[plan])`.
- **Heartbeat refresh effect** — calls `loadFeed()` on a newly-completed scan whose
  intervals include `servedInterval`, deduped on `lastScanAt`.

The Favorites/Risk controls are removed from the body grid and rendered inside
`UserMenu` in the header row. `saveFavorites` and `handleToggleFavorite` stay in
`DashboardLive` (unchanged) and are passed into `UserMenu` so the row star and the
menu share one source of truth (Req 8).

### `UserMenu` (new) — `src/components/dashboard/user-menu.tsx`

A client component using the existing `dropdown-menu` primitive. It receives its
data + the favorites callbacks as props (no fetching of its own):

```ts
export interface UserMenuProps {
  plan: "free" | "pro" | "ultimate";
  /** For the avatar initials + the menu label. */
  email: string;
  name?: string | null;

  // Risk defaults seed (all tiers).
  initialLeverage: number;
  initialRrRatio: string;

  // Favorites: shared state owned by DashboardLive so the row star stays in sync.
  favorites: string[];
  onAddFavorite: (symbol: string) => void;    // = handleToggleFavorite(sym, false)
  onRemoveFavorite: (symbol: string) => void; // = handleToggleFavorite(sym, true)
}
```

Structure:

- **Trigger:** a small round button showing initials derived from `name`/`email`
  (a lightweight `initialsFromIdentity(name, email)` helper — see Testing). Uses
  `DropdownMenuTrigger` with `asChild`.
- **Content:** a wide `DropdownMenuContent` (`align="end"`) containing:
  - a `DropdownMenuLabel` with the email + a plan badge (handles `ultimate`),
  - the `RiskDefaults` form (embedded; unchanged props),
  - the `FavoritesManager` (embedded; `favorites`, `onAdd`, `onRemove` wired to the
    props above),
  - a `DropdownMenuSeparator`,
  - an Upgrade `DropdownMenuItem` linking to `/dashboard/upgrade` (Free only),
  - a Sign out `DropdownMenuItem` (`variant="destructive"`) calling
    `signOut({ callbackUrl: "/" })`.

> Interaction note: `RiskDefaults` and `FavoritesManager` contain inputs and
> buttons. Radix menu `Item`s auto-close and steal typing focus, so these forms
> are rendered **outside** `DropdownMenuItem` (as plain children inside the
> content, wrapped so `onSelect`/keyboard nav does not hijack them). Only the
> Upgrade and Sign out actions are real `DropdownMenuItem`s.

### Minimal avatar (no `components/ui/avatar.tsx` wrapper exists)

Confirmed: only the `radix-ui/avatar` primitive is present in `node_modules`; there
is no project wrapper. Rather than introduce a new wrapper for a single call site,
the design uses a lightweight initials button as the dropdown trigger:

```tsx
<button
  type="button"
  aria-label="Account menu"
  className="flex size-8 items-center justify-center rounded-full
             bg-primary/15 text-xs font-semibold text-primary"
>
  {initials}
</button>
```

This keeps the change small and avoids a new dependency surface. (If a shared
avatar is wanted later, it can be introduced without changing `UserMenu`'s props.)

### `layout.tsx` (small correctness fix)

The plan badge currently renders `PRO`/`FREE` only and mislabels Ultimate as FREE.
Fix the badge to handle three plans:

```tsx
{plan === "ultimate" ? "ULTIMATE" : plan === "pro" ? "PRO" : "FREE"}
```

with matching styling for the ultimate case. The layout does **not** need to load
preferences (the `UserMenu` lives inside `DashboardLive`, which already receives
them from `page.tsx`).

## Refresh Mechanism Design (Concern A)

### Chosen approach: heartbeat-driven primary + modest safety-net poll

**Rationale.** Req 1 wants freshness aligned to Tier_Cadence (Req 2). The real
scan cadence is emitted by the worker over the socket as `scanStatus`
(`{ scanning, intervals, trigger, lastScanAt }`). The existing scan-time effect
already listens to it. The most accurate, tier-aligned trigger is therefore the
heartbeat itself: when a scan for the viewer's served interval *completes*, that is
exactly the moment new slice data exists, so we refetch then. This satisfies Req 2
by construction (the heartbeat fires per real scan at the tier's cadence) without
hard-coding candle-period timers that would feel dead (a 15m poll for Free).

A single feed read is one `MGET`-backed request, so it is cheap. We add a **modest
per-tier safety-net poll** to cover the cases the heartbeat cannot: socket
disconnected (Req 2.4), missed heartbeat, or first paint before any scan completes.
The poll intervals are deliberately shorter than the candle period so the view
never looks frozen, but still tier-scaled (faster tiers poll more often):

| Plan | Served interval | Heartbeat trigger (primary) | Safety-net poll (fallback) |
|------|-----------------|------------------------------|-----------------------------|
| free | 15m | on completed 15m scan | every 60s |
| pro | 5m | on completed 5m scan | every 30s |
| ultimate | 1m | on completed 1m scan | every 15s |

These values are the documented, chosen numbers. The heartbeat is the "aligned"
refresh (Req 2.1–2.3); the poll is the socket-independent guarantee (Req 2.4).

### Heartbeat refresh effect (Req 1.2, 2.1–2.3)

```ts
// Refresh when a scan for the served interval completes. Dedupe on lastScanAt so
// repeated identical heartbeats don't retrigger, and so we don't loop.
const lastRefreshAtRef = useRef<number>(0);
useEffect(() => {
  if (!scanStatus || scanStatus.scanning) return;
  const ivs = scanStatus.intervals;
  if (!ivs || !ivs.includes(servedInterval as Interval)) return;
  if (scanStatus.lastScanAt <= lastRefreshAtRef.current) return; // dedupe
  lastRefreshAtRef.current = scanStatus.lastScanAt;
  void loadFeed();
}, [scanStatus, servedInterval, loadFeed]);
```

Loop/storm avoidance:
- `loadFeed` is a stable `useCallback([indexUsd])`, so the effect identity is
  stable and does not re-fire on every render.
- The `lastScanAt` guard ensures a given completed scan triggers **at most one**
  refresh, even though `scanStatus` may re-emit.
- This effect is independent of the existing scan-time tracking effect (which
  updates the `scanTimes` map for the pills); both may read the same heartbeat but
  neither loops the other.

### Safety-net poll effect (Req 1.1, 2.4)

```ts
useEffect(() => {
  const id = setInterval(() => { void loadFeed(); }, REFRESH_MS[plan]);
  return () => clearInterval(id);
}, [plan, loadFeed]);
```

Runs regardless of socket state, satisfying Req 2.4. Because `loadFeed` is stable,
the interval is created once per plan and cleaned up on unmount.

### No-flicker during refresh (Req 1.7)

`loadFeed` sets `loadingFeed = true` at the start, but the loader is only rendered
when `loadingFeed && rows.length === 0`. Once at least one row is present, a
refresh does **not** show the full-screen loader — the existing rows stay on screen
until the new data replaces them. This already satisfies Req 1.7; the design keeps
this render guard exactly as-is and adds no new full-screen spinner on periodic
refresh. (The small "Saving…" spinner is removed along with `savingPref`.)

### Stale row replacement + socket-merge interaction (Req 1.6, 1.3, 1.4, 1.5)

`loadFeed` already replaces `analyses` wholesale from the feed and rebuilds
`usdByKey` and `scanTimes`, satisfying Req 1.3/1.4/1.5 and the "removed rows
disappear" half of Req 1.6.

**Risk (called out):** the Pro/Ultimate socket-merge effect builds a `Map` keyed by
`symbol:interval` seeded from the previous `analyses` and then overlays
`latestSignals`. If a symbol drops out of the feed but a stale `latestSignals`
entry for it still exists, the merge could re-introduce the removed row, defeating
Req 1.6.

**Resolution — feed is the source of truth for membership.** The socket merge is
changed so it only *updates fields of rows already present in the feed set*; it
never adds a symbol that the latest feed did not include:

```ts
useEffect(() => {
  if ((plan !== "pro" && plan !== "ultimate") || latestSignals.length === 0) return;
  setAnalyses((prev) => {
    const present = new Set(prev.map((a) => `${a.symbol}:${a.interval}`));
    const byKey = new Map<string, FeedRow>();
    for (const a of prev) byKey.set(`${a.symbol}:${a.interval}`, a);
    for (const a of latestSignals) {
      const key = `${a.symbol}:${a.interval}`;
      if (present.has(key)) byKey.set(key, a); // update only; never introduce
    }
    return Array.from(byKey.values());
  });
}, [plan, latestSignals]);
```

This keeps live in-place updates (Req 9.5 ticks still flow via `latestTicks`, and
above-threshold analyses still refresh visible rows) while ensuring a feed refresh
that removes a symbol wins. Because `loadFeed` replaces `analyses`, the very next
socket merge recomputes `present` from the refreshed set, so a refresh is not
clobbered by a stale merge.

### Failure handling (Req 1.8)

`loadFeed`'s `try/catch` already swallows errors and keeps prior state (the
`finally` only clears `loadingFeed`). Both the heartbeat effect and the poll call
the same `loadFeed`, so on failure the last-good rows remain and subsequent
attempts continue on the poll cadence. No change needed beyond documenting it.

### No full page reload (Req 1.9)

All refresh paths call `loadFeed` (a `fetch`), never `router.refresh()` or a
navigation. Satisfied by construction.

## Concern B — Remove timeframe tabs

Changes:

1. **Delete** `src/components/dashboard/timeframe-selector.tsx`. Recommended over
   leaving dead code. Its only external export beyond the component is
   `DisplayInterval`, relocated inline into `dashboard-live.tsx` (above) so imports
   don't break. (Verified `DisplayInterval` consumers: `dashboard-live.tsx` only.)
2. **Remove** the `<TimeframeSelector/>` usage and the surrounding header block in
   `DashboardLive` (Req 3.1). No replacement control that switches the served
   timeframe is added (Req 3.2).
3. **Derive** `servedInterval = SERVED_INTERVAL[plan]` (Req 3.3/3.4/3.5). The rows
   filter becomes `a.interval === servedInterval`; the live-tick channel and
   favorite-tick channel use `servedInterval`.
4. **Remove** `persistInterval` and its PATCH, plus `handleSelect`/
   `handleLockedClick` and `savingPref` (Req 4.1). The dashboard sends no
   `intervals` PATCH anymore.
5. **Preferences API unchanged** (Req 4.2/4.3/4.4): the route still accepts
   `intervals` for back-compat, still merges only provided fields (so editing
   favorites/risk from the menu preserves stored `intervals`), and still renders
   correctly for any stored `intervals` value because the client no longer reads
   `active` from it.
6. **Retained read-only last-scan indicator (Req 3.6).** Replace the multi-pill
   "Last scan" switcher row with a single read-only pill for `servedInterval` only:
   ```
   {servedInterval} · scanned {timeAgo(scanTimes[servedInterval]) ?? "—"}
   ```
   The existing `scanLabel`/`timeAgo`/`scanStatus.scanning` logic is reused, just
   pinned to `servedInterval` instead of `active`. This is display-only and offers
   no timeframe control.

## Concern C — Avatar settings menu placement (decision + rationale)

### Decision: Option 1 — co-locate `UserMenu` inside `DashboardLive`'s header row

**The problem.** Favorites live in `DashboardLive` state and drive both the row
star and (now) the menu's `FavoritesManager`. Req 8 requires the two to stay
consistent, and Req 8.4 requires a Feed_Refresh after a favorites change.
`DashboardLive` is rendered by `page.tsx`; the global header is rendered by the
separate server `layout.tsx` subtree. Putting the menu in the layout would split
favorites state across two React trees, forcing a shared client store/context or
`router.refresh()` + event plumbing.

**Chosen solution.** Render `UserMenu` in a header row **at the top of the signals
view inside `DashboardLive`**, next to the Live/scan status pills. Favorites and
risk state stay co-located: `UserMenu` receives `favorites`, `onAddFavorite`,
`onRemoveFavorite` (bound to the existing `handleToggleFavorite`) and the risk
seeds as props. Req 8 becomes trivial — there is one `favorites` state, one
`saveFavorites` (already does optimistic update + `loadFeed()` on success, covering
Req 8.4), and the row star and menu render from the same set.

**Tradeoff (documented).** The avatar menu appears in the dashboard content header
rather than the global top-right site header. This is a deliberate, acceptable
tradeoff for satisfying Req 8 without cross-subtree state. Req 5.1 says the
"Dashboard_Header" renders the Avatar_Menu; the glossary defines Dashboard_Header
as the region from `layout.tsx`, but the requirement's intent (a header-level
avatar menu for authenticated users) is met by the signals-view header row, which
is the top of the authenticated dashboard content.

**Alternative if the global header is required (Option 3).** Keep `UserMenu` in
`layout.tsx`; on any favorites/risk change, the menu PATCHes then broadcasts a
`window` `CustomEvent` (e.g. `"favorites:changed"`) carrying the new list.
`DashboardLive` listens for it, updates its `favorites` state, and calls
`loadFeed()`. `layout.tsx` would fetch `getUserPreferences` (like `page.tsx`) to
seed the menu. This works but adds an event contract and duplicated preference
loading. Option 1 is recommended; Option 3 is the fallback only if the product
requires the menu in the global header specifically.

### Embedding RiskDefaults and FavoritesManager (Req 6, 7, 8)

- **RiskDefaults**: embedded unchanged. It already PATCHes
  `/api/user/preferences` with `{ defaultLeverage, defaultRrRatio }`, validates
  against `MAX_LEVERAGE`/`RR_RATIO_PATTERN` client-side (mirrored by the API), and
  toasts on failure (Req 6.2–6.6). Removed from the body grid (Req 6.1).
- **FavoritesManager**: embedded unchanged, wired to `DashboardLive`'s
  `favorites` + `handleToggleFavorite`. Removed from the body grid (Req 7.1).
  Caps come from `plan` (`FREE_MAX_FAVORITES`/`PRO_MAX_FAVORITES`, Req 7.3/7.4).
- **Favorites save path (Req 8.1–8.4)**: both the row star and the menu call the
  same `handleToggleFavorite` → `saveFavorites`, which:
  1. optimistically updates `favorites` (row star + menu re-render together —
     Req 8.2/8.3),
  2. PATCHes `{ favoritePairs }` (Req 8.1/7.5),
  3. on success calls `loadFeed()` so pinned favorite rows refresh (Req 8.4),
  4. on cap/error rolls back and surfaces the upgrade modal or a toast (Req 7.6).

### Sign out and Upgrade (Req 5)

- **Sign out** item calls `signOut({ callbackUrl: "/" })` — same behavior as the
  existing `SignOutButton` (Req 5.3/5.5).
- **Upgrade** item renders only when `plan === "free"`, linking to
  `/dashboard/upgrade` (Req 5.4).
- Activating the trigger opens the dropdown panel with settings + account links
  (Req 5.1/5.2).

## Data Models

No new persisted data models. The design reuses existing shapes:

- Feed responses (`FeedFreeResponse` / `FeedFullResponse`) — unchanged.
- `ScanStatus` (`{ scanning, intervals, trigger, lastScanAt }`) — read-only input
  to the heartbeat effect.
- `UserPreferences` (`intervals`, `favoritePairs`, `defaultLeverage`,
  `defaultRrRatio`) — persisted via the unchanged Preferences_API.

New in-memory constants only: `SERVED_INTERVAL`, `REFRESH_MS`, relocated
`DisplayInterval` type, and a `lastRefreshAtRef` dedupe ref.

## Error Handling

- **Feed refresh failure (Req 1.8):** `loadFeed`'s `catch` retains prior rows;
  poll + heartbeat keep retrying. No user-facing error on transient refresh
  failures (avoids toast spam on a background poll).
- **Favorites PATCH failure (Req 7.6):** `saveFavorites` rolls back the optimistic
  update; a Free cap breach opens the upgrade modal, other errors toast.
- **Risk defaults validation (Req 6.6):** `RiskDefaults` validates before PATCH and
  toasts a specific message; the API re-validates and returns a 400 whose message
  is surfaced.
- **Socket disconnected (Req 2.4):** safety-net poll continues; the status pill
  shows "Connecting…" while `isConnected` is false; no crash.
- **Sign out failure:** delegated to `next-auth` `signOut`; unchanged behavior.

## Testing Strategy

This project has **no jest/vitest**; it runs standalone `tsx` scripts registered in
`package.json` (`test:unit`, `test:engine`, `test:ai`, `test:integration`,
`test:e2e`) using a tiny inline assert harness (see `scripts/test-unit.ts`). The UI
here is React client state that is hard to unit-test without a DOM/test runner, so
testing focuses on the **extracted pure logic**, with manual steps for the UI.

### Extracted pure helpers to unit-test (added to `scripts/test-unit.ts`)

1. **`servedIntervalForPlan(plan)`** — the `SERVED_INTERVAL` mapping, extracted as
   a pure function/const so it can be asserted:
   - `free → "15m"`, `pro → "5m"`, `ultimate → "1m"` (Req 3.3/3.4/3.5).
2. **`refreshMsForPlan(plan)`** — the `REFRESH_MS` mapping:
   - `free → 60000`, `pro → 30000`, `ultimate → 15000`, and the invariant
     `refreshMs(ultimate) < refreshMs(pro) < refreshMs(free)` (faster tier refreshes
     more often — Req 2.1–2.3 ordering).
3. **`shouldRefreshOnHeartbeat(scanStatus, servedInterval, lastRefreshAt)`** — the
   pure predicate behind the heartbeat effect, extracted so the dedupe/guard logic
   is testable without React:
   - returns `false` when `scanning` is true, when `intervals` omits
     `servedInterval`, or when `lastScanAt <= lastRefreshAt` (dedupe);
   - returns `true` for a completed scan including `servedInterval` with a newer
     `lastScanAt` (Req 1.2, 2.x; loop-avoidance).
4. **`initialsFromIdentity(name, email)`** — avatar initials helper:
   - uses name initials when present, falls back to the email's first char(s),
     always returns 1–2 uppercase chars.

These helpers live in a small module (e.g. `src/components/dashboard/dashboard-live.helpers.ts`)
so both `DashboardLive` and the test script import them.

### Manual verification steps (UI — cannot be scripted here)

- **Auto-refresh (Req 1):** load the dashboard on each tier; confirm rows/USD/last-
  scan update without reload — via the heartbeat (watch a scan complete) and via
  the poll (temporarily block the socket / go offline; rows still refresh on the
  tier cadence). Confirm no full-screen loader flashes on refresh when rows exist.
- **Stale removal (Req 1.6):** remove a favorite that was the only reason a symbol
  appeared; confirm the row disappears after refresh and is not re-introduced by a
  stale socket signal.
- **No tabs (Req 3):** confirm no timeframe pills for any tier and no way to switch
  the served interval; confirm the read-only last-scan pill shows the served
  interval only.
- **Preference back-compat (Req 4):** with a stored `intervals` value, confirm the
  dashboard renders and that editing favorites/risk from the menu leaves stored
  `intervals` unchanged (inspect the PATCH payload / DB).
- **Avatar menu (Req 5/6/7):** open the menu on each tier; confirm RiskDefaults +
  FavoritesManager are present (and absent from the body), Upgrade shows for Free
  only, Sign out ends the session and redirects.
- **Favorites consistency (Req 8):** toggle a star on a row and confirm the menu's
  list updates; add/remove in the menu and confirm the row star updates; confirm a
  favorites change triggers a feed refresh (pinned rows update).
- **Non-regression (Req 9):** confirm Free pinning/obscuring, favorites/risk
  persistence across reload, and live ticks still work.

### Property-based testing applicability

PBT is **not** appropriate here. The core changes are React UI wiring, timer/effect
orchestration, and moving existing components — there is no pure transformation with
a meaningful "for all inputs" property beyond the small mapping/predicate helpers
above, which are fully covered by exhaustive example assertions (three plans; a
handful of heartbeat cases). No property-based tests or `Correctness Properties`
section is included.

## Requirements → Design Mapping

| Requirement | Design coverage |
|-------------|-----------------|
| 1.1 periodic refresh | Safety-net poll effect (`REFRESH_MS[plan]`) |
| 1.2 heartbeat refresh | Heartbeat refresh effect (dedupe on `lastScanAt`) |
| 1.3 rows update | `loadFeed` replaces `analyses` wholesale |
| 1.4 USD update | `loadFeed` rebuilds `usdByKey` via `indexUsd` |
| 1.5 last-scan update | `loadFeed` merges `scanTimes` |
| 1.6 stale removal | Wholesale replace + socket merge restricted to present keys |
| 1.7 no flicker | Existing `loadingFeed && rows.length === 0` render guard retained |
| 1.8 failure handling | `loadFeed` catch retains rows; poll/heartbeat keep retrying |
| 1.9 no page reload | All paths call `loadFeed` (fetch), never navigation |
| 2.1–2.3 tier-aligned cadence | Heartbeat per served interval + tier-scaled poll |
| 2.4 disconnected socket | Poll runs independent of socket state |
| 3.1/3.2 no selector | Delete `TimeframeSelector`, remove usage, no switch control |
| 3.3–3.5 served interval | `SERVED_INTERVAL[plan]` drives rows filter + channels |
| 3.6 read-only cadence | Single read-only last-scan pill for `servedInterval` |
| 4.1 no intervals PATCH | Remove `persistInterval`/`handleSelect` |
| 4.2 render regardless of stored intervals | Client no longer reads `active` from prefs |
| 4.3 preserve stored intervals | Preferences_API merges only provided fields (unchanged) |
| 4.4 API back-compat | Preferences_API still accepts `intervals` (unchanged) |
| 5.1/5.2 avatar menu | `UserMenu` in `DashboardLive` header row |
| 5.3/5.5 sign out | `UserMenu` Sign out → `signOut({callbackUrl:"/"})` |
| 5.4 upgrade link | `UserMenu` Upgrade item (Free only) |
| 6.1 remove risk from body | RiskDefaults moved into `UserMenu` |
| 6.2–6.6 risk form behavior | RiskDefaults embedded unchanged (validation + PATCH) |
| 7.1 remove favorites from body | FavoritesManager moved into `UserMenu` |
| 7.2–7.6 favorites behavior | FavoritesManager embedded, wired to `handleToggleFavorite` |
| 8.1–8.4 favorites consistency | Single `favorites` state + `saveFavorites` (Option 1) |
| 9.1–9.5 non-regression | Row-building, pinning/obscuring, persistence, ticks unchanged |

## Design Decisions & Rationale (summary)

- **Heartbeat-primary + poll-fallback** over pure candle-period timers: aligns to
  real scan cadence (Req 2) while never looking frozen, and stays socket-resilient
  (Req 2.4). Chosen poll numbers: 60s/30s/15s.
- **Delete `TimeframeSelector`, relocate `DisplayInterval`**: avoids dead code
  without breaking the one importer.
- **Socket merge restricted to feed-present keys**: makes the feed the single
  source of truth for row membership so refreshes actually remove stale rows
  (Req 1.6) without losing live in-place updates.
- **Option 1 (menu inside `DashboardLive`)**: satisfies Req 8 with one favorites
  state and no cross-subtree plumbing; tradeoff is placement in the content header
  rather than the global site header (Option 3 documented as the fallback).
- **Lightweight initials trigger** instead of a new avatar wrapper: keeps the
  change small; no new dependency surface.
