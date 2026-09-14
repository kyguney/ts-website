import { cn } from "@/lib/utils";

/**
 * A tiny inline SVG sparkline. Renders a smooth polyline of the given points,
 * auto-scaled to the viewbox, with an optional soft area fill.
 */
export function Sparkline({
  points,
  className,
  stroke = "var(--ts-emerald)",
  fill = true,
  width = 120,
  height = 36,
  strokeWidth = 1.75,
}: {
  points: number[];
  className?: string;
  stroke?: string;
  fill?: boolean;
  width?: number;
  height?: number;
  strokeWidth?: number;
}) {
  if (!points || points.length < 2) {
    return <div className={cn("h-9 w-full", className)} aria-hidden />;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const pad = strokeWidth;

  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = pad + (1 - (p - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });

  const line = coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const areaPath = `M ${coords[0][0]},${height} L ${coords
    .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" L ")} L ${coords[coords.length - 1][0]},${height} Z`;

  const gradId = `spark-${stroke.replace(/[^a-z0-9]/gi, "")}-${points.length}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-9 w-full overflow-visible", className)}
      role="img"
      aria-label="price sparkline"
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#${gradId})`} />
        </>
      )}
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
