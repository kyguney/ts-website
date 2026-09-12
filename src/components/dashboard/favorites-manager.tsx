"use client";

import { useState } from "react";
import { Star, X, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FREE_MAX_FAVORITES, PRO_MAX_FAVORITES } from "@/lib/validation";

export interface FavoritesManagerProps {
  plan: "free" | "pro" | "ultimate";
  favorites: string[];
  /** Add a symbol (parent enforces caps + persistence). */
  onAdd: (symbol: string) => void;
  /** Remove a symbol. */
  onRemove: (symbol: string) => void;
}

/** Normalizes user input into a Binance-style symbol (e.g. "btc" -> "BTCUSDT"). */
export function normalizeSymbol(raw: string): string {
  let s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return "";
  if (!s.endsWith("USDT") && !s.endsWith("USDC") && !s.endsWith("USD")) {
    s = `${s}USDT`;
  }
  return s;
}

export function FavoritesManager({
  plan,
  favorites,
  onAdd,
  onRemove,
}: FavoritesManagerProps) {
  const [input, setInput] = useState("");
  const max = plan === "free" ? FREE_MAX_FAVORITES : PRO_MAX_FAVORITES;

  const submit = () => {
    const sym = normalizeSymbol(input);
    if (!sym) return;
    setInput("");
    if (favorites.includes(sym)) return;
    onAdd(sym);
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Star className="size-4 text-amber-400" />
          Favorites
          <span className="text-xs text-muted-foreground">
            {favorites.length}/{max}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          Up to {max} favorites
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {favorites.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No favorites yet — tap the ☆ on any row, or add one below.
          </span>
        )}
        {favorites.map((sym) => (
          <span
            key={sym}
            className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-300"
          >
            {sym}
            <button
              type="button"
              onClick={() => onRemove(sym)}
              className="rounded-full p-0.5 hover:bg-white/10"
              aria-label={`Remove ${sym}`}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}

        <div className="flex items-center gap-1.5">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Add symbol (e.g. BTC)"
            className="h-8 w-40 text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={cn("h-8 gap-1 px-2.5 text-xs")}
            onClick={submit}
          >
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {plan === "free"
          ? "Favorites are scanned on 15m and pinned to the top of your list."
          : "Favorites are pinned to the top of every timeframe."}
      </p>
    </div>
  );
}
