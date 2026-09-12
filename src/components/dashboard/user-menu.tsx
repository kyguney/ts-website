"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { LogOut, Sparkles } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { FavoritesManager } from "@/components/dashboard/favorites-manager";
import { RiskDefaults } from "@/components/dashboard/risk-defaults";
import {
  initialsFromIdentity,
  type Plan,
} from "@/components/dashboard/dashboard-live.helpers";

export interface UserMenuProps {
  plan: Plan;
  /** For the avatar initials + the menu label. */
  email: string;
  name?: string | null;

  // Risk defaults seed (all tiers).
  initialLeverage: number;
  initialRrRatio: string;

  // Favorites: shared state owned by DashboardLive so the row star stays in sync.
  favorites: string[];
  onAddFavorite: (symbol: string) => void; // = handleToggleFavorite(sym, false)
  onRemoveFavorite: (symbol: string) => void; // = handleToggleFavorite(sym, true)
}

/** Plan badge label + palette, handling all three tiers (Req 5.2). */
const PLAN_BADGE: Record<Plan, { label: string; className: string }> = {
  ultimate: {
    label: "ULTIMATE",
    className: "bg-fuchsia-400/15 text-fuchsia-300",
  },
  pro: {
    label: "PRO",
    className: "bg-primary/15 text-primary",
  },
  free: {
    label: "FREE",
    className: "bg-white/10 text-muted-foreground",
  },
};

/**
 * Avatar dropdown for the authenticated dashboard header. Holds the Risk
 * defaults form, the Favorites manager, an Upgrade link (Free only), and Sign
 * out. It owns no data of its own — favorites state + callbacks are passed in
 * by `DashboardLive` so the row star and the menu stay consistent (Req 8).
 *
 * Interaction note: `RiskDefaults` and `FavoritesManager` contain inputs and
 * buttons. Radix `DropdownMenuItem`s auto-close and steal typing focus, so the
 * forms are rendered as plain content children OUTSIDE any `DropdownMenuItem`.
 * Only the Upgrade and Sign out actions are real menu items.
 */
export function UserMenu({
  plan,
  email,
  name,
  initialLeverage,
  initialRrRatio,
  favorites,
  onAddFavorite,
  onRemoveFavorite,
}: UserMenuProps) {
  const initials = initialsFromIdentity(name, email);
  const badge = PLAN_BADGE[plan];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary transition hover:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {initials}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between gap-2">
          <span className="truncate text-sm text-muted-foreground">{email}</span>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide",
              badge.className,
            )}
          >
            {badge.label}
          </span>
        </DropdownMenuLabel>

        {/* Forms rendered OUTSIDE DropdownMenuItem so menu onSelect / keyboard
            nav does not steal focus or auto-close them. */}
        <div className="flex flex-col gap-3 px-1 py-1.5">
          <RiskDefaults
            initialLeverage={initialLeverage}
            initialRrRatio={initialRrRatio}
          />
          <FavoritesManager
            plan={plan}
            favorites={favorites}
            onAdd={onAddFavorite}
            onRemove={onRemoveFavorite}
          />
        </div>

        <DropdownMenuSeparator />

        {plan === "free" && (
          <DropdownMenuItem asChild>
            <Link href="/dashboard/upgrade">
              <Sparkles className="size-4" />
              Upgrade to Pro
            </Link>
          </DropdownMenuItem>
        )}

        <DropdownMenuItem
          variant="destructive"
          onSelect={() => void signOut({ callbackUrl: "/" })}
        >
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
