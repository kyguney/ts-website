import { cn } from "@/lib/utils";

type Signal = {
  symbol: string;
  price: string;
  direction: "LONG" | "SHORT";
  score: number;
  change: string;
};

// Mock data for the demo. Replaced by the real prediction engine in a later phase.
const SIGNALS: Signal[] = [
  { symbol: "BTCUSDT", price: "$68,240", direction: "LONG", score: 82, change: "+2.4%" },
  { symbol: "ETHUSDT", price: "$3,510", direction: "LONG", score: 74, change: "+1.8%" },
  { symbol: "SOLUSDT", price: "$168.20", direction: "SHORT", score: 69, change: "-3.1%" },
  { symbol: "1000BONK", price: "$0.0000221", direction: "LONG", score: 88, change: "+9.6%" },
  { symbol: "LDOUSDT", price: "$1.94", direction: "SHORT", score: 63, change: "-1.2%" },
];

export function SignalDemo() {
  return (
    <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          Live signals
        </div>
        <span className="text-xs text-muted-foreground">Sample data · 15m timeframe</span>
      </div>

      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-muted-foreground">
          <tr className="border-b border-white/10">
            <th className="px-4 py-2 font-medium">Symbol</th>
            <th className="px-4 py-2 font-medium">Price</th>
            <th className="px-4 py-2 font-medium">Signal</th>
            <th className="px-4 py-2 text-right font-medium">Score</th>
            <th className="px-4 py-2 text-right font-medium">24h</th>
          </tr>
        </thead>
        <tbody>
          {SIGNALS.map((s) => {
            const isLong = s.direction === "LONG";
            return (
              <tr key={s.symbol} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3 font-semibold">{s.symbol}</td>
                <td className="px-4 py-3 text-muted-foreground">{s.price}</td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                      isLong
                        ? "bg-emerald-500/15 text-emerald-400"
                        : "bg-rose-500/15 text-rose-400"
                    )}
                  >
                    {s.direction}
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
                        style={{ width: `${s.score}%` }}
                      />
                    </div>
                    <span className="tabular-nums">{s.score}</span>
                  </div>
                </td>
                <td
                  className={cn(
                    "px-4 py-3 text-right tabular-nums",
                    s.change.startsWith("+") ? "text-emerald-400" : "text-rose-400"
                  )}
                >
                  {s.change}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
