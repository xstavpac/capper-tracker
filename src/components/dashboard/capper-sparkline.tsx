import { SPARKLINE_MIN_PICKS, sparklineTone, type CapperSparkline as Series } from "@/server/data/cappers-page-aggregates";

const STROKE = { up: "#10b981", down: "#ef4444", flat: "#9ca3af" } as const;

// Cumulative-units line for a capper's last 20 graded picks. Server-rendered SVG: green when the
// run is net positive, red when net negative, grey when flat (net 0, or fewer than 3 graded picks,
// which draws a plain flat line).
export function CapperSparkline({
  series,
  width,
  height = 20,
  className,
}: {
  series: Series | undefined;
  // Omit for a full-width line (the SVG stretches to its container).
  width?: number;
  height?: number;
  className?: string;
}) {
  const tone = sparklineTone(series);
  const W = 100;
  const pad = 2;
  const points = series && series.n >= SPARKLINE_MIN_PICKS ? series.points : null;

  let path = "";
  if (points) {
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    path = points
      .map((v, i) => {
        const x = (i / (points.length - 1)) * W;
        const y = points.every((p) => p === points[0]) ? height / 2 : height - pad - ((v - min) / span) * (height - pad * 2);
        return (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2);
      })
      .join(" ");
  } else {
    path = "M0 " + height / 2 + " L" + W + " " + height / 2;
  }

  return (
    <svg viewBox={"0 0 " + W + " " + height} preserveAspectRatio="none" width={width ?? "100%"} height={height} className={className} role="img" aria-label="Units over last 20 graded picks">
      <path d={path} fill="none" stroke={STROKE[tone]} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// "+6.1u L20" / "−3.2u L20" / "0.0u L20"; null (no label) below the minimum sample.
export function sparklineLabel(series: Series | undefined): { text: string; tone: "up" | "down" | "flat" } | null {
  if (!series || series.n < SPARKLINE_MIN_PICKS) return null;
  const n = series.netUnits;
  return { text: (n < 0 ? "−" : n > 0 ? "+" : "") + Math.abs(n).toFixed(1) + "u L20", tone: sparklineTone(series) };
}
