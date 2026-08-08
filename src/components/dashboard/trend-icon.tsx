// Zigzag line + solid triangular arrowhead, classic "stock trending" shape.
// The down variant is the up variant's coordinates mirrored vertically
// (newY = 24 - y), not a CSS flip - keeps it a plain SVG shape that composes
// cleanly with its own independent surge-translate animation below.
const ICONS = {
  up: {
    body: "M2 19 L9 12 L13 15.5 L19 8",
    head: "M22 4 L14 6 L20.5 11.5 Z",
    colorClass: "text-emerald-600",
    surgeClass: "animate-trend-surge-up",
  },
  down: {
    body: "M2 5 L9 12 L13 8.5 L19 16",
    head: "M22 20 L14 18 L20.5 12.5 Z",
    colorClass: "text-red-600",
    surgeClass: "animate-trend-surge-down",
  },
} as const;

export function TrendIcon({ direction }: { direction: "up" | "down" }) {
  const icon = ICONS[direction];
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      aria-hidden="true"
      className={"shrink-0 " + icon.colorClass + " " + icon.surgeClass}
    >
      <path d={icon.body} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      <path d={icon.head} fill="currentColor" className="animate-trend-glow" />
    </svg>
  );
}
