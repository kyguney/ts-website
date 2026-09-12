"use client";

import { useState } from "react";
import { Loader2, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_LEVERAGE, RR_RATIO_PATTERN } from "@/lib/validation";

export interface RiskDefaultsProps {
  /** Seeded from the server-loaded preferences. */
  initialLeverage: number;
  initialRrRatio: string;
}

/** Common R:R presets offered via the input's datalist (free text still allowed). */
const RR_PRESETS = ["1:1", "1:1.5", "1:2", "1:3", "1:4", "1:5"];

/**
 * "Risk defaults" — a small form to edit the user's default leverage and
 * risk:reward ratio. Available to ALL tiers (risk params are not gated).
 * PATCHes /api/user/preferences with { defaultLeverage, defaultRrRatio }.
 *
 * Validation mirrors the API (Req 6.5 / validation.ts):
 *   • leverage: integer in [1, MAX_LEVERAGE]
 *   • rrRatio:  matches ^1:\d+(\.\d+)?$
 */
export function RiskDefaults({
  initialLeverage,
  initialRrRatio,
}: RiskDefaultsProps) {
  const [leverage, setLeverage] = useState(String(initialLeverage));
  const [rrRatio, setRrRatio] = useState(initialRrRatio);
  const [saving, setSaving] = useState(false);

  const validate = (): { defaultLeverage: number; defaultRrRatio: string } | null => {
    const lev = Number.parseInt(leverage, 10);
    if (!Number.isInteger(lev) || lev < 1 || lev > MAX_LEVERAGE) {
      toast.error(`Leverage must be a whole number between 1 and ${MAX_LEVERAGE}.`);
      return null;
    }
    const rr = rrRatio.trim();
    if (!RR_RATIO_PATTERN.test(rr)) {
      toast.error('Risk:reward must look like "1:2" or "1:3.5".');
      return null;
    }
    return { defaultLeverage: lev, defaultRrRatio: rr };
  };

  const handleSave = async () => {
    const payload = validate();
    if (!payload) return;

    setSaving(true);
    try {
      const res = await fetch("/api/user/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(body?.error ?? "Couldn't save your risk defaults.");
      } else {
        // Keep the input canonical (trimmed) after a successful save.
        setRrRatio(payload.defaultRrRatio);
        setLeverage(String(payload.defaultLeverage));
        toast.success("Risk defaults saved.");
      }
    } catch {
      toast.error("Couldn't save your risk defaults.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <SlidersHorizontal className="size-4 text-primary" />
        Risk defaults
        <span className="text-xs font-normal text-muted-foreground">
          Applied to your TP/SL sizing
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="risk-leverage" className="text-xs text-muted-foreground">
            Leverage
          </Label>
          <div className="flex items-center gap-1.5">
            <Input
              id="risk-leverage"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_LEVERAGE}
              step={1}
              value={leverage}
              onChange={(e) => setLeverage(e.target.value)}
              disabled={saving}
              className="h-8 w-24 text-sm"
            />
            <span className="text-xs text-muted-foreground">
              x (max {MAX_LEVERAGE})
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="risk-rr" className="text-xs text-muted-foreground">
            Risk : Reward
          </Label>
          <Input
            id="risk-rr"
            list="risk-rr-presets"
            value={rrRatio}
            onChange={(e) => setRrRatio(e.target.value)}
            placeholder="1:2"
            disabled={saving}
            className="h-8 w-28 text-sm"
          />
          <datalist id="risk-rr-presets">
            {RR_PRESETS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          onClick={handleSave}
          disabled={saving}
        >
          {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
