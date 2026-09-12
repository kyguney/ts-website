# Requirements Document

## Introduction

This spec is a follow-up to the completed `tiered-scan-caching` spec. It addresses three focused, related dashboard concerns without expanding into unrelated redesign:

- **Concern A — Auto-refreshing signals (BUG fix):** The signals feed loads once on mount and then goes stale. `src/components/dashboard/dashboard-live.tsx` calls `loadFeed()` (GET `/api/analysis/feed`) exactly once inside a mount `useEffect` with no polling. After that, updates depend solely on the live WebSocket: for Pro/Ultimate it merges `latestSignals` from the AI stream (`AI_SIGNALS_CHANNEL` / `market:ai:analysis`), which only fires when the orchestrator produces a NEW above-threshold AI analysis; the per-tier slice rows and the per-user `usd` envelope are never re-fetched. For Free it only changes on a new `free_broadcast`. Net effect: the table populates from the first fetch and then never refreshes. The desired behavior is that signals stay fresh automatically, aligned to each tier's scan cadence.

- **Concern B — Remove timeframe/period tabs for all tiers:** The `TimeframeSelector` pill row (`src/components/dashboard/timeframe-selector.tsx`) must be removed for every tier. Each tier is served a single fixed cadence (Free = 15m, Pro = 5m, Ultimate = 1m). Users no longer switch periods, so the per-interval preference PATCH path that backed the selector is removed from the dashboard flow. Stored `intervals` preferences must remain backward compatible.

- **Concern C — Compact user-management settings under an avatar popup menu:** Introduce a net-new avatar dropdown in the dashboard header (no such component exists today; only the radix-ui/avatar primitive is available). Both the Risk defaults form and the Favorites manager move out of the dashboard body and into this avatar settings menu, alongside account links (Upgrade for Free, Sign out).

This document specifies WHAT the system must do. Exact refresh intervals, component structure, and layout details are deferred to the design phase.

## Glossary

- **Dashboard**: The authenticated signals view rendered by `src/app/dashboard/page.tsx` with the client component `DashboardLive` (`src/components/dashboard/dashboard-live.tsx`).
- **Dashboard_Header**: The header region rendered by `src/app/dashboard/layout.tsx`.
- **Signals_Feed**: The tiered analysis data returned by GET `/api/analysis/feed` (`src/app/api/analysis/feed/route.ts`), including per-tier slice rows and the per-user USD envelope.
- **Feed_Refresh**: The client operation (`loadFeed`) that re-fetches the Signals_Feed and updates the visible rows, USD amounts, and scan-time indicators.
- **Live_Socket**: The WebSocket client hook `useMarketSocket` (`src/hooks/useMarketSocket.ts`), which exposes `latestTicks`, `latestSignals`, `freeSignals`, `latestBroadcast`, and `scanStatus`.
- **Scan_Status_Heartbeat**: The `scanStatus` value emitted over Live_Socket carrying `scanning`, `intervals`, `trigger`, and `lastScanAt`.
- **Tier_Cadence**: The fixed scan/refresh cadence per plan — Free = 15m, Pro = 5m, Ultimate = 1m.
- **Timeframe_Selector**: The removed interval-pill component (`src/components/dashboard/timeframe-selector.tsx`).
- **Avatar_Menu**: The net-new avatar dropdown in the Dashboard_Header containing the compact settings panel and account links.
- **Risk_Defaults**: The default-leverage and risk:reward editing form (`src/components/dashboard/risk-defaults.tsx`).
- **Favorites_Manager**: The favorite-symbols management component (`src/components/dashboard/favorites-manager.tsx`).
- **Favorite_Star**: The per-row star control in the signals table used to toggle a symbol's favorite state.
- **Preferences_API**: The endpoint PATCH `/api/user/preferences` (`src/app/api/user/preferences/route.ts`) that persists `intervals`, `favoritePairs`, `defaultLeverage`, and `defaultRrRatio`.
- **MAX_LEVERAGE**: The leverage cap from `src/lib/validation.ts` (default 125).
- **RR_RATIO_PATTERN**: The risk:reward validator `^1:\d+(\.\d+)?$` from `src/lib/validation.ts`.

## Requirements

### Requirement 1 — Auto-refreshing signals feed (Concern A)

**User Story:** As a signed-in trader, I want the signals table to stay fresh automatically, so that I always see current picks and sizing without manually reloading the page.

#### Acceptance Criteria

1. WHILE the Dashboard is mounted, THE Dashboard SHALL periodically perform Feed_Refresh on an interval aligned to the viewer's Tier_Cadence.
2. WHEN the Scan_Status_Heartbeat reports a completed scan for the viewer's served interval, THE Dashboard SHALL perform Feed_Refresh.
3. WHEN a Feed_Refresh completes, THE Dashboard SHALL update the visible signal rows to reflect the latest Signals_Feed contents.
4. WHEN a Feed_Refresh completes, THE Dashboard SHALL update each row's USD envelope (TP1/TP2/SL) to the values returned by the Signals_Feed.
5. WHEN a Feed_Refresh completes, THE Dashboard SHALL update the "Last scan" indicators to reflect the scan times returned by the Signals_Feed.
6. WHEN a Feed_Refresh returns a set of rows that differs from the current set, THE Dashboard SHALL replace stale rows so that rows no longer present in the Signals_Feed are removed.
7. WHILE a Feed_Refresh is in progress and the Dashboard already displays at least one row, THE Dashboard SHALL continue displaying the existing rows until the refreshed data is available.
8. IF a Feed_Refresh fails, THEN THE Dashboard SHALL retain the most recently displayed rows and continue subsequent refresh attempts on the Tier_Cadence.
9. THE Dashboard SHALL perform Feed_Refresh without a full page reload.

### Requirement 2 — Tier-aligned refresh cadence (Concern A)

**User Story:** As a trader on a specific plan, I want refresh frequency to match my plan's scan cadence, so that faster tiers see faster updates and slower tiers avoid unnecessary requests.

#### Acceptance Criteria

1. WHERE the viewer's plan is `free`, THE Dashboard SHALL align its periodic Feed_Refresh to the 15-minute Free Tier_Cadence.
2. WHERE the viewer's plan is `pro`, THE Dashboard SHALL align its periodic Feed_Refresh to the 5-minute Pro Tier_Cadence.
3. WHERE the viewer's plan is `ultimate`, THE Dashboard SHALL align its periodic Feed_Refresh to the 1-minute Ultimate Tier_Cadence.
4. WHILE the Live_Socket is disconnected, THE Dashboard SHALL continue periodic Feed_Refresh on the Tier_Cadence so that signals remain current without the socket.

### Requirement 3 — Remove timeframe/period tabs (Concern B)

**User Story:** As a trader, I want a single fixed cadence for my plan without period tabs, so that the dashboard is simpler and I only see the timeframe my plan provides.

#### Acceptance Criteria

1. THE Dashboard SHALL NOT render the Timeframe_Selector for any plan.
2. THE Dashboard SHALL NOT present any control that lets a user switch the served timeframe.
3. WHERE the viewer's plan is `free`, THE Dashboard SHALL display signals for the 15m served interval.
4. WHERE the viewer's plan is `pro`, THE Dashboard SHALL display signals for the 5m served interval.
5. WHERE the viewer's plan is `ultimate`, THE Dashboard SHALL display signals for the 1m served interval.
6. THE Dashboard MAY display a read-only indication of the current cadence and last-scan information.

### Requirement 4 — Retire the timeframe preference path from the dashboard flow (Concern B)

**User Story:** As a trader, I want the dashboard to stop editing my timeframe preference, so that removing the selector does not silently change or break my stored settings.

#### Acceptance Criteria

1. THE Dashboard SHALL NOT send any request to the Preferences_API that changes the `intervals` preference.
2. WHEN the Dashboard loads for a user with a stored `intervals` preference, THE Dashboard SHALL render correctly regardless of the stored `intervals` value.
3. WHERE a user has a previously stored `intervals` preference, THE system SHALL preserve that stored value unchanged when the user edits other preferences from the Avatar_Menu.
4. THE Preferences_API SHALL continue to accept an `intervals` field for backward compatibility with existing clients.

### Requirement 5 — Avatar menu in the dashboard header (Concern C)

**User Story:** As a signed-in user, I want a compact avatar menu in the header, so that I can manage my account and settings without cluttering the signals view.

#### Acceptance Criteria

1. THE Dashboard_Header SHALL render an Avatar_Menu control for authenticated users.
2. WHEN a user activates the Avatar_Menu control, THE Avatar_Menu SHALL open a dropdown panel containing the settings panel and account links.
3. THE Avatar_Menu SHALL include a Sign out action that signs the current user out.
4. WHERE the viewer's plan is `free`, THE Avatar_Menu SHALL include an Upgrade link.
5. WHEN a user activates the Sign out action, THE system SHALL end the user's session and redirect to the sign-in flow.

### Requirement 6 — Move Risk defaults into the avatar menu (Concern C)

**User Story:** As a trader, I want my risk defaults inside the avatar settings menu, so that the signals body stays focused on signals while my sizing controls remain accessible.

#### Acceptance Criteria

1. THE Dashboard body SHALL NOT render the Risk_Defaults form.
2. THE Avatar_Menu SHALL render the Risk_Defaults form for all plans (`free`, `pro`, `ultimate`).
3. WHEN a user submits a leverage value, THE system SHALL accept the value only if it is an integer within the range 1 to MAX_LEVERAGE inclusive.
4. WHEN a user submits a risk:reward value, THE system SHALL accept the value only if it matches RR_RATIO_PATTERN.
5. WHEN a user saves valid Risk_Defaults, THE Avatar_Menu SHALL PATCH the Preferences_API with `{ defaultLeverage, defaultRrRatio }`.
6. IF a user submits a leverage value outside the range 1 to MAX_LEVERAGE or a risk:reward value that does not match RR_RATIO_PATTERN, THEN THE system SHALL reject the submission and surface a validation message.

### Requirement 7 — Move Favorites management into the avatar menu (Concern C)

**User Story:** As a trader, I want to manage my favorite pairs from the avatar settings menu, so that favorites editing is centralized and off the main signals view.

#### Acceptance Criteria

1. THE Dashboard body SHALL NOT render the Favorites_Manager.
2. THE Avatar_Menu SHALL render the Favorites_Manager for all plans (`free`, `pro`, `ultimate`).
3. WHERE the viewer's plan is `free`, THE Favorites_Manager SHALL allow at most 3 favorite pairs.
4. WHERE the viewer's plan is `pro` or `ultimate`, THE Favorites_Manager SHALL allow at most 10 favorite pairs.
5. WHEN a user saves a change to favorites from the Avatar_Menu, THE Avatar_Menu SHALL PATCH the Preferences_API with `{ favoritePairs }`.
6. IF a user attempts to add a favorite beyond the plan's cap, THEN THE system SHALL reject the addition and surface the cap to the user.

### Requirement 8 — Consistent favorites between the row star and the menu (Concern C)

**User Story:** As a trader, I want the star on a signal row and the favorites list in the menu to always agree, so that toggling a favorite in one place is reflected in the other.

#### Acceptance Criteria

1. THE Favorite_Star and the Favorites_Manager SHALL both persist favorites through the same `favoritePairs` preference via the Preferences_API.
2. WHEN a user toggles a Favorite_Star on a signal row, THE Dashboard SHALL update the favorites set used by both the row stars and the Avatar_Menu Favorites_Manager to the same value.
3. WHEN a user adds or removes a favorite in the Avatar_Menu, THE Dashboard SHALL reflect the change in the corresponding row's Favorite_Star state.
4. WHEN a favorites change is persisted, THE Dashboard SHALL perform Feed_Refresh so that pinned favorite rows reflect the updated favorites.

### Requirement 9 — Non-regression of existing behavior

**User Story:** As an existing user, I want current signal rendering, favorites persistence, and risk-default persistence to keep working, so that these changes do not break what already works.

#### Acceptance Criteria

1. THE Dashboard SHALL continue to render signal rows for Free, Pro, and Ultimate plans according to each tier's existing display rules.
2. WHERE the viewer's plan is `free`, THE Dashboard SHALL continue to pin favorite rows above non-favorite rows and continue to obscure non-favorite rows beyond the top pick with the existing upgrade CTA.
3. WHEN a user saves favorites, THE system SHALL persist the change to the `favoritePairs` preference so that the change survives a page reload.
4. WHEN a user saves Risk_Defaults, THE system SHALL persist `defaultLeverage` and `defaultRrRatio` so that the changes survive a page reload.
5. THE system SHALL continue to display live price ticks for visible and favorite rows via the Live_Socket.
