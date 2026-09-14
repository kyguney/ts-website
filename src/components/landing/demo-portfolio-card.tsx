import { cn } from "@/lib/utils";

type Slice = { asset: string; pct: number; color: string };

const ALLOCATION: Slice[] = [
  { asset: "BTC", pct: 40, color: "#00b875" },
  { asset: "ETH", pct: 30, color: "#38bdf8" },
  { asset: "SOL", pct: 20, color: "#00b4d8" },
  { asset: "USDT", pct: 10, color: "#94a3b8" },
];

const POSITIONS = [
  { asset: "BTC", amount: "0.006", entry: "65,230.00", pnl: "+4.2%", up: true },
  { asset: "ETH", amount: "0.25", entry: "3,020.00", pnl: "+1.5%", up: true },
  { asset: "SOL", amount: "2.0", entry: "148.30", pnl: "-0.8%", up: false },
];

/** Renders a conic-gradient donut from the allocation slices. */
function Donut() {
  let acc = 0;
  const stops = ALLOCATION.map((s) => {
    const start = acc;
    acc += s.pct;
    return `${s.color} ${start}% ${acc}%`;
  }).join(", ");

  return (
    <div
      className="relative size-28 shrink-0 rounded-full"
      style={{ background: `conic-gradient(${stops})` }}
      role="img"
      aria-label="Portfolio allocation"
    >
      <div className="absolute inset-[18%] rounded-full bg-[var(--ts-canvas-2)]" />
    </div>
  );
}

/**
 * Demo Portfolio card for the "Test your strategy" section: virtual balance,
 * allocation donut (BTC/ETH/SOL/USDT), and a compact positions table.
 */
export function DemoPortfolioCard() {
  return (
    <div className="ts-card p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Demo Portfolio</h3>
        <span className="rounded-full bg-[var(--ts-cyan)]/15 px-2.5 py-0.5 text-[10px] font-semibold text-[var(--ts-cyan-2)]">
          VIRTUAL FUNDS ONLY
        </span>
      </div>

      <div className="mt-5 flex items-center gap-6">
        <div>
          <div className="text-xs text-[var(--ts-text-muted)]">Virtual Balance</div>
          <div className="mt-1 text-3xl font-bold tabular-nums">$1,000.00</div>
          <div className="mt-1 text-sm font-medium text-[var(--ts-emerald)]">
            +2.4% Total Return
          </div>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <Donut />
          <ul className="space-y-1.5 text-xs">
            {ALLOCATION.map((s) => (
              <li key={s.asset} className="flex items-center gap-2">
                <span
                  className="size-2.5 rounded-sm"
                  style={{ background: s.color }}
                  aria-hidden
                />
                <span className="text-[var(--ts-text-muted)]">{s.asset}</span>
                <span className="ml-auto tabular-nums">{s.pct}%</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-2 text-xs font-semibold text-[var(--ts-text-muted)]">
          Positions
        </div>
        <table className="w-full text-left text-xs">
          <thead className="text-[10px] uppercase text-[var(--ts-text-muted)]">
            <tr className="border-b border-[var(--ts-stroke)]">
              <th className="pb-2 font-medium">Asset</th>
              <th className="pb-2 font-medium">Amount</th>
              <th className="pb-2 font-medium">Entry</th>
              <th className="pb-2 text-right font-medium">P/L</th>
            </tr>
          </thead>
          <tbody>
            {POSITIONS.map((p) => (
              <tr key={p.asset} className="border-b border-white/[0.04] last:border-0">
                <td className="py-2 font-semibold">{p.asset}</td>
                <td className="py-2 text-[var(--ts-text-muted)] tabular-nums">{p.amount}</td>
                <td className="py-2 text-[var(--ts-text-muted)] tabular-nums">${p.entry}</td>
                <td
                  className={cn(
                    "py-2 text-right font-medium tabular-nums",
                    p.up ? "text-[var(--ts-emerald)]" : "text-[var(--ts-red)]",
                  )}
                >
                  {p.pnl}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
