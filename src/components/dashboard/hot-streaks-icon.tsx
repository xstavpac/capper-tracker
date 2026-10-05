const FLAME_PATH = "M12 2c1 3-2 4-2 7a3 3 0 1 0 6 0c1 1 2 2.5 2 4.5A6.5 6.5 0 0 1 5 13.5C5 8 12 6 12 2Z";

// Two layered flame shapes (same silhouette, different color/scale) flicker
// on independent keyframes/durations so they don't move as one rigid unit -
// plus a few embers that rise and fade above the flame on a staggered loop.
// Exported so the Sharp Money page's Fav ML category icon (same "flame"
// concept - a capper on a hot run of favorite-moneyline picks) can reuse this
// exact component instead of duplicating the flame shape/animation - see
// src/components/sharp-money/category-icons.tsx.
export function HotStreaksIcon() {
  return (
    <span className="relative inline-block h-5 w-5 shrink-0" aria-hidden="true">
      <span
        className="absolute left-[7px] top-0 h-[3px] w-[3px] rounded-full bg-amber-300 animate-ember-rise"
        style={{ animationDelay: "0s" }}
      />
      <span
        className="absolute left-[11px] top-0.5 h-[3px] w-[3px] rounded-full bg-orange-300 animate-ember-rise"
        style={{ animationDelay: "0.6s" }}
      />
      <span
        className="absolute left-[9px] top-0 h-[3px] w-[3px] rounded-full bg-amber-300 animate-ember-rise"
        style={{ animationDelay: "1.2s" }}
      />
      <svg viewBox="0 0 24 24" fill="currentColor" className="absolute inset-0 h-5 w-5 origin-bottom text-orange-500 animate-flame-outer">
        <path d={FLAME_PATH} />
      </svg>
      <svg viewBox="0 0 24 24" fill="currentColor" className="absolute inset-0 h-5 w-5 origin-bottom text-amber-300 animate-flame-inner">
        <path d={FLAME_PATH} />
      </svg>
    </span>
  );
}
