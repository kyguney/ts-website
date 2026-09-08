"use client";

import Link from "next/link";
import { Lock, Sparkles } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface UpgradeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional context, e.g. the locked timeframe that triggered the modal. */
  reason?: string;
}

/**
 * Clean upgrade prompt shown when a Free user attempts a Pro-only action
 * (locked timeframe, obscured signal row). Points at /dashboard/upgrade.
 */
export function UpgradeModal({ open, onOpenChange, reason }: UpgradeModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Sparkles className="size-5" />
          </div>
          <DialogTitle>Unlock the full market with Pro</DialogTitle>
          <DialogDescription>
            {reason ??
              "This timeframe is available on the Pro plan."}{" "}
            Get real-time 5m / 30m breakout alerts, every symbol, and instant AI
            trade signals.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-primary" /> All timeframes: 5m,
            15m, 30m, 1h
          </li>
          <li className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-primary" /> Live AI entry / SL /
            TP with R:R
          </li>
          <li className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-primary" /> Full unblurred
            real-time candidate table
          </li>
        </ul>

        <DialogFooter className="mt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="gap-1.5"
          >
            <Lock className="size-3.5" /> Maybe later
          </Button>
          <Button asChild>
            <Link href="/dashboard/upgrade">See Pro plans</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
