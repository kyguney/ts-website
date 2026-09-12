# Implementation Plan: Dashboard Settings and Refresh

## Overview

This plan implements the three concerns from the design against the existing
`DashboardLive` client component and the tiered feed:

- **Concern A** — auto-refreshing signals (heartbeat-driven primary refresh +
  tier-scaled safety-net poll, with feed-as-source-of-truth stale-row removal).
- **Concern B** — remove the `TimeframeSelector`, derive a single `servedInterval`
  per tier, and drop the `intervals` preference PATCH path.
- **Concern C** — a net-new `UserMenu` avatar dropdown (Option 1: co-located inside
  `DashboardLive`'s header row) holding Risk defaults, Favorites, Upgrade, Sign out.

The implementation language is **TypeScript/React** (matches the design and the
existing codebase). No property-based tests: per the design's Testing Strategy, PBT
is not applicable, so testing covers the extracted pure helpers with example
assertions in `scripts/test-unit.ts` plus a manual UI checklist.

Tasks are ordered so each step builds on the previous one and the project stays
buildable: helpers first, then the new `UserMenu`, then the `DashboardLive`
rewiring that consumes both, then deletion of the now-unused selector, then the
layout badge fix, then tests and verification.

## Tasks

- [x] 1. Extract pure helpers and fix the layout badge (foundation)
  - [x] 1.1 Create the shared helpers module
    - Create `src/components/dashboard/dashboard-live.helpers.ts`.
    - Relocate the `DisplayInterval` type here (currently exported from
      `timeframe-selector.tsx`, which will be deleted):
      `type DisplayInterval = SelectableInterval | "1m"`.
    - Export `SERVED_INTERVAL` (`free: "15m"`, `pro: "5m"`, `ultimate: "1m"`) and a
      pure `servedIntervalForPlan(plan)` returning the served `DisplayInterval`.
    - Export `REFRESH_MS` (`free: 60_000`, `pro: 30_000`, `ultimate: 15_000`) and a
      pure `refreshMsForPlan(plan)` accessor.
    - Export the pure predicate `shouldRefreshOnHeartbeat(scanStatus, servedInterval, lastRefreshAt)`:
      returns `false` when `scanStatus` is absent, when `scanning` is true, when
      `intervals` omits `servedInterval`, or when `lastScanAt <= lastRefreshAt`
      (dedupe); returns `true` for a completed scan including `servedInterval` with a
      newer `lastScanAt`.
    - Export `initialsFromIdentity(name, email)`: prefers name initials, falls back
      to the email local part, always returns 1–2 uppercase chars.
    - Import `SelectableInterval`, the `plan` union, and `ScanStatus`/`Interval` from
      their existing modules so the helpers type-check against real project types.
    - _Requirements: 3.3, 3.4, 3.5, 2.1, 2.2, 2.3, 1.2_

  - [x] 1.2 Fix the dashboard layout plan badge
    - In `src/app/dashboard/layout.tsx`, update the plan badge to render three plans
      (`ultimate` → "ULTIMATE", `pro` → "PRO", else "FREE") with matching styling for
      the ultimate case, so Ultimate is no longer mislabeled as FREE.
    - _Requirements: 4.2, 9.1_

- [x] 2. Build the new `UserMenu` client component
  - [x] 2.1 Implement `UserMenu`
    - Create `src/components/dashboard/user-menu.tsx` as a client component using the
      existing `dropdown-menu` primitive.
    - Define `UserMenuProps` per the design: `plan`, `email`, `name?`,
      `initialLeverage`, `initialRrRatio`, `favorites`, `onAddFavorite`,
      `onRemoveFavorite` (no internal fetching).
    - Trigger: a lightweight round initials button (via `initialsFromIdentity`) using
      `DropdownMenuTrigger asChild` with `aria-label="Account menu"`.
    - Content (`align="end"`): a `DropdownMenuLabel` with the email plus a plan badge
      that handles `ultimate`/`pro`/`free`.
    - Embed the existing `RiskDefaults` form (unchanged props) and `FavoritesManager`
      (wired to `favorites` / `onAddFavorite` / `onRemoveFavorite`) as plain content
      children rendered **outside** any `DropdownMenuItem` so menu `onSelect`/keyboard
      nav does not steal focus or auto-close the forms.
    - Add an Upgrade `DropdownMenuItem` (Free only) linking to `/dashboard/upgrade`,
      and a Sign out `DropdownMenuItem` (`variant="destructive"`) calling
      `signOut({ callbackUrl: "/" })`, separated by a `DropdownMenuSeparator`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 7.1, 7.2_

- [x] 3. Rewire `DashboardLive` and mount the menu + auto-refresh
  - [x] 3.1 Derive the served interval and remove the timeframe selector usage
    - In `src/components/dashboard/dashboard-live.tsx`, remove the `TimeframeSelector`
      import and its usage/header block; import `DisplayInterval`, `SERVED_INTERVAL`
      from the helpers module.
    - Remove `active`/`setActive`, `handleSelect`, `handleLockedClick`,
      `persistInterval`, and `savingPref`; derive
      `const servedInterval = SERVED_INTERVAL[plan]`.
    - Replace every prior use of `active` with `servedInterval`: the rows filter
      (`a.interval === servedInterval`), the live-tick channel subscription, and the
      favorite-tick channel subscription.
    - Replace the multi-pill "Last scan" switcher row with a single read-only
      last-scan pill for `servedInterval` (reuse `scanLabel`/`timeAgo`/
      `scanStatus.scanning`), offering no timeframe control.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1_

  - [x] 3.2 Mount `UserMenu` in the header row (Concern C, Option 1)
    - Remove `FavoritesManager` and `RiskDefaults` from the dashboard body grid.
    - Render `UserMenu` in `DashboardLive`'s header row next to the Live/scan status
      pills, passing `plan`, `email`, `name`, `initialLeverage`, `initialRrRatio`,
      `favorites`, and `onAddFavorite`/`onRemoveFavorite` bound to the existing
      `handleToggleFavorite` (add = not-removing, remove = removing).
    - Keep `saveFavorites`/`handleToggleFavorite` in `DashboardLive` so the row star
      and the menu share one `favorites` source of truth and a favorites change still
      calls `loadFeed()`.
    - _Requirements: 6.1, 7.1, 8.1, 8.2, 8.3, 8.4_

  - [x] 3.3 Add the auto-refresh mechanism (Concern A)
    - Add a safety-net poll effect:
      `setInterval(() => void loadFeed(), REFRESH_MS[plan])`, cleaned up on unmount,
      keyed on `[plan, loadFeed]` (runs regardless of socket state).
    - Add a heartbeat-driven refresh effect using a `lastRefreshAtRef` dedupe: call
      `loadFeed()` when
      `shouldRefreshOnHeartbeat(scanStatus, servedInterval, lastRefreshAtRef.current)`
      is true, then set `lastRefreshAtRef.current = scanStatus.lastScanAt`.
    - Restrict the Pro/Ultimate `latestSignals` socket-merge so it only updates keys
      already present in the current feed set (feed = source of truth for
      membership); never introduce a symbol the latest feed did not include, so stale
      rows are removed.
    - Confirm the no-flicker render guard stays (`loadingFeed && rows.length === 0`);
      do not add a full-screen spinner on periodic refresh.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.1, 2.2, 2.3, 2.4_

- [x] 4. Delete the timeframe selector
  - [x] 4.1 Remove the dead selector file
    - Delete `src/components/dashboard/timeframe-selector.tsx`.
    - Verify no remaining importers of the file or its `DisplayInterval` export other
      than the relocated helper (grep the `src` tree); fix any stragglers to import
      `DisplayInterval` from the helpers module.
    - _Requirements: 3.1, 3.2_

- [x] 5. Checkpoint — build and typecheck
  - Run `npm run build` and `npm run worker:typecheck`; resolve any type or import
    errors introduced by the helper extraction, `UserMenu`, `DashboardLive` rewiring,
    the file deletion, and the layout fix. Ensure all tests pass, ask the user if
    questions arise.

- [x] 6. Tests and verification
  - [x] 6.1 Add unit tests for the extracted helpers
    - Extend `scripts/test-unit.ts` (existing inline assert harness) with example
      assertions importing from `dashboard-live.helpers.ts`:
      - `servedIntervalForPlan`: `free → "15m"`, `pro → "5m"`, `ultimate → "1m"`.
      - `refreshMsForPlan`: `free → 60000`, `pro → 30000`, `ultimate → 15000`, and
        the ordering invariant `ultimate < pro < free`.
      - `shouldRefreshOnHeartbeat`: false when scanning, false when `intervals` omits
        the served interval, false when `lastScanAt <= lastRefreshAt` (dedupe), true
        for a newer completed scan including the served interval.
      - `initialsFromIdentity`: name-based initials, email fallback, always 1–2
        uppercase chars.
    - Run `npm run test:unit` and confirm all assertions pass.
    - _Requirements: 1.2, 2.1, 2.2, 2.3, 3.3, 3.4, 3.5_

  - [x] 6.2 Final verification
    - Run `npm run build`, `npm run worker:typecheck`, and `npm run test:unit`; all
      must pass.
    - Walk the manual UI checklist from the design:
      - Auto-refresh via heartbeat (watch a scan complete) and via poll/offline
        (block socket / go offline; rows still refresh on tier cadence) with no
        full-screen loader flash when rows exist (Req 1, 2).
      - Stale-row removal: removing the only reason a symbol appears drops the row on
        refresh and it is not re-introduced by a stale socket signal (Req 1.6).
      - No timeframe tabs and no served-interval switch for any tier; read-only
        last-scan pill shows the served interval only (Req 3).
      - Preference back-compat: with a stored `intervals` value the dashboard
        renders, and editing favorites/risk from the menu leaves stored `intervals`
        unchanged (Req 4).
      - Avatar menu contents per tier: RiskDefaults + FavoritesManager present
        (absent from body), Upgrade for Free only, Sign out ends the session
        (Req 5, 6, 7).
      - Favorites consistency: row star ↔ menu list stay in sync and a change
        triggers a feed refresh (Req 8).
      - Non-regression: Free pinning/obscuring + upgrade CTA, favorites/risk
        persistence across reload, live ticks (Req 9).
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5_

## Notes

- Tasks marked with `*` are optional (test/type-check scaffolding) and can be
  skipped for a faster MVP; core implementation tasks are never optional.
- Each task references the specific requirement IDs it addresses for traceability.
- No property-based tests: per the design Testing Strategy, PBT is not applicable to
  this UI/timer wiring; the extracted pure helpers are covered by example assertions.
- Requirements coverage across the plan:
  - Req 1 (1.1–1.9): task 3.3 (verified in 6.2)
  - Req 2 (2.1–2.4): tasks 1.1, 3.3 (verified in 6.2)
  - Req 3 (3.1–3.6): tasks 1.1, 3.1, 4.1
  - Req 4 (4.1–4.4): tasks 3.1, 1.2 (4.3/4.4 hold via the unchanged Preferences_API —
    no dashboard PATCH of `intervals`, verified in 6.2)
  - Req 5 (5.1–5.5): task 2.1
  - Req 6 (6.1–6.6): tasks 2.1, 3.2 (6.2–6.6 provided by embedding the unchanged
    `RiskDefaults`, verified in 6.2)
  - Req 7 (7.1–7.6): tasks 2.1, 3.2 (7.2–7.6 provided by embedding the unchanged
    `FavoritesManager`, verified in 6.2)
  - Req 8 (8.1–8.4): task 3.2
  - Req 9 (9.1–9.5): tasks 1.2, 6.2 (verified as non-regression)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["6.1", "6.2"] }
  ]
}
```
