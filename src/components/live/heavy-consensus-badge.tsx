"use client";

import { useRef, useState } from "react";
import { heavyBadgeDetails, heavyBadgeText, type HeavyBadge } from "@/lib/heavy-consensus";

// The Heavy Consensus pill, set just above a pick header on the Live tab (Grid's
// team / Totals sections, Feed's expander groups, /live/[gameId]) when that
// header's side is a heavy-consensus side (lib/heavy-consensus.ts). Amber on
// purpose: the blue accent already means "swapped" in the Parlay Generator, and
// it is never green / red - the hit rate is shown as-is, good or bad. Numbers
// in monospace. Tap (touch) or hover (pointer) shows the market, the capper
// count and the sample size in a small popover under the pill.
export function HeavyConsensusBadge({ badge, className = "" }: { badge: HeavyBadge; className?: string }) {
  const [open, setOpen] = useState(false);
  // A mouse already opened it on hover, so its click must not shut it; a tap or Enter toggles.
  const pointer = useRef<string | null>(null);
  const details = heavyBadgeDetails(badge);
  return (
    // Hover only for a mouse: a tap also fires pointerenter, which would open the
    // popover just before the click toggled it shut again.
    <div
      className={"relative w-fit " + className}
      onPointerEnter={(e) => e.pointerType === "mouse" && setOpen(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setOpen(false)}
    >
      <button
        onPointerDown={(e) => (pointer.current = e.pointerType)}
        type="button"
        onClick={(e) => {
          // Feed's expander sits inside a game card link.
          e.preventDefault();
          e.stopPropagation();
          const byMouse = pointer.current === "mouse";
          pointer.current = null;
          setOpen((o) => (byMouse ? true : !o));
        }}
        aria-expanded={open}
        aria-label={heavyBadgeText(badge) + ". " + details}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-500/45 bg-amber-500/10 px-2 py-[3px] text-[10px] font-semibold uppercase leading-none tracking-wide outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 dark:border-amber-400/40 dark:bg-amber-400/10"
      >
        <span className="text-amber-700 dark:text-amber-300">
          Heavy cons <span className="font-mono tabular-nums">{badge.sharePct}%</span>
        </span>
        <span className="text-[#5B6275] dark:text-muted-foreground" aria-hidden="true">
          ·
        </span>
        <span className="text-[#5B6275] dark:text-muted-foreground">
          Hit rate <span className="font-mono tabular-nums">{badge.hitRatePct}%</span>
        </span>
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute left-0 top-full z-20 mt-1 w-max max-w-[min(19rem,calc(100vw-2rem))] rounded-md border border-amber-500/35 bg-white px-2 py-1.5 text-[11px] font-medium leading-snug text-foreground shadow-[0_6px_18px_rgba(15,20,32,0.10)] dark:border-amber-400/30 dark:bg-card dark:shadow-none"
        >
          {details}
        </div>
      )}
    </div>
  );
}
