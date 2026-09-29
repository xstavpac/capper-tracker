// Cumulative-units line for a capper's last 20 decided picks. Server-rendered SVG;
// green when the run is net positive (or flat), red when net negative.
export function CapperSparkline({
  points,
  width,
  height = 20,
  className,
}: {
  points: number[];
  // Omit for a full-width line (the SVG stretches to its container).
  width?: number;
  height?: number;
  className?: string;
}) {
  const netUp = (points[points.length - 1] ?? 0) >= 0;
  const stroke = netUp ? "#10b981" : "#ef4444";
  const W = 100;
  const pad = 2;

  let path = "";
  if (points.length >= 2) {
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    path = points
      .map((v, i) => {
        const x = (i / (points.length - 1)) * W;
        const y = height - pad - ((v - min) / span) * (height - pad * 2);
        return (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2);
      })
      .join(" ");
  }

  return (
    <svg
      viewBox={"0 0 " + W + " " + height}
      preserveAspectRatio="none"
      width={width ?? "100%"}
      height={height}
      className={className}
      role="img"
      aria-label="Units over last 20 picks"
    >
      {path ? (
        <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ) : (
        <line x1={0} x2={W} y1={height / 2} y2={height / 2} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

export function formatUnits(n: number): string {
  return (n < 0 ? "−" : "+") + Math.abs(n).toFixed(1) + "u";
}
