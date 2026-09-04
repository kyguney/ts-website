import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

type Row = {
  symbol: string;
  price: string;
  direction: "LONG" | "SHORT";
  score: number;
  change: string;
  proOnly?: boolean;
};

// Mock signals. The real prediction engine is ported in a later phase.
const ROWS: Row[] = [
  { symbol: "BTCUSDT", price: "$68,240", direction: "LONG", score: 82, change: "+2.4%" },
  { symbol: "ETHUSDT", price: "$3,510", direction: "LONG", score: 74, change: "+1.8%" },
  { symbol: "SOLUSDT", price: "$168.20", direction: "SHORT", score: 69, change: "-3.1%" },
  { symbol: "1000BONKUSDT", price: "$0.0000221", direction: "LONG", score: 88, change: "+9.6%", proOnly: true },
  { symbol: "LDOUSDT", price: "$1.94", direction: "SHORT", score: 63, change: "-1.2%", proOnly: true },
  { symbol: "PENGUUSDT", price: "$0.0331", direction: "LONG", score: 77, change: "+4.2%", proOnly: true },
  { symbol: "ALGOUSDT", price: "$0.181", direction: "SHORT", score: 58, change: "-0.9%", proOnly: true },
];

export function SignalsTable({ plan }: { plan: "free" | "pro" }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-muted-foreground">
          <tr className="border-b border-white/10">
            <th className="px-4 py-3 font-medium">Symbol</th>
            <th className="px-4 py-3 font-medium">Price</th>
            <th className="px-4 py-3 font-medium">Signal</th>
            <th className="px-4 py-3 text-right font-medium">Score</th>
            <th className="px-4 py-3 text-right font-medium">24h</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => {
            const locked = plan === "free" && r.proOnly;
            const isLong = r.direction === "LONG";
            return (
              <tr key={r.symbol} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3 font-semibold">{r.symbol}</td>
                {locked ? (
                  <td colSpan={4} className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Lock className="size-3.5" /> Upgrade to Pro to unlock
                    </span>
                  </td>
                ) : (
                  <>
                    <td className="px-4 py-3 text-muted-foreground">{r.price}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                          isLong
                            ? "bg-emerald-500/15 text-emerald-400"
                            : "bg-rose-500/15 text-rose-400"
                        )}
                      >
                        {r.direction}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              isLong ? "bg-emerald-500" : "bg-rose-500"
                            )}
                            style={{ width: `${r.score}%` }}
                          />
                        </div>
                        <span className="tabular-nums">{r.score}</span>
                      </div>
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right tabular-nums",
                        r.change.startsWith("+") ? "text-emerald-400" : "text-rose-400"
                      )}
                    >
                      {r.change}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
