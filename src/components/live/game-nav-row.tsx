"use client";

import { useEffect, useRef, useState } from "react";

// Prev / Next game row at the top of Grid Live's game detail card. Pinned to the top of the viewport
// while the (possibly very tall) card scrolls under it. The site header and Slate Bar are NOT fixed in
// this app (the header is `relative`, so it scrolls away with the page), so the sticky offset is 0 -
// there is no header to clear. The row bleeds to the card's edges (-m-3.5 cancels the card's p-3.5).
//
// "Stuck" styling (a shadow) is driven by a zero-height sentinel just above the row: once the sentinel
// has scrolled off the top of the viewport the row is pinned. No scroll listener.

// The row's rendered height (44px buttons + 10px padding top and bottom + 1px border). The board's
// auto-scroll reads this so the first team header lands below the pinned row, not under it.
export const GAME_NAV_ROW_HEIGHT = 65;

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path d={dir === "left" ? "M15 18l-6-6 6-6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

const BTN = "inline-flex min-h-11 items-center justify-center gap-1 whitespace-nowrap rounded-[10px] px-3 text-[13px] min-[400px]:gap-1.5 min-[400px]:px-3.5 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:cursor-not-allowed";

export function GameNavRow({
  index,
  total,
  onPrev,
  onNext,
}: {
  // 0-based position of the selected game in the Games list, and the list's length.
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      // Not intersecting AND above the viewport = the row has reached its pinned position.
      setStuck(!entry.isIntersecting && entry.boundingClientRect.top < 0);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const first = index <= 0;
  const last = index >= total - 1;

  return (
    <>
      <div ref={sentinelRef} aria-hidden="true" className="-mt-3.5 h-px" />
      <div
        data-game-nav-row
        className={
          "sticky top-0 z-20 -mx-3.5 mb-3 flex items-center justify-between gap-2 rounded-t-[18px] border-b border-[#E3E6EE] bg-white px-3.5 py-2.5 transition-shadow dark:border-border dark:bg-card " +
          (stuck ? "shadow-[0_6px_12px_-6px_rgba(15,20,32,0.18)]" : "")
        }
      >
        <button
          type="button"
          onClick={onPrev}
          disabled={first}
          className={BTN + (first ? " border border-[#E3E6EE] bg-white text-muted-foreground opacity-50 dark:border-border dark:bg-card" : " border border-[#DADDE5] bg-white text-foreground hover:bg-[#F5F6FA] dark:border-border dark:bg-card dark:hover:bg-white/[0.06]")}
        >
          <Chevron dir="left" />
          Prev game
        </button>
        <span className="shrink-0 whitespace-nowrap text-center text-xs font-medium text-muted-foreground">
          <span className="max-[359px]:hidden">Game {index + 1} of {total}</span>
          <span className="min-[360px]:hidden" aria-label={"Game " + (index + 1) + " of " + total}>{index + 1}/{total}</span>
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={last}
          className={BTN + (last ? " bg-brand-600 text-white opacity-40" : " bg-brand-600 text-white hover:bg-brand-700")}
        >
          Next game
          <Chevron dir="right" />
        </button>
      </div>
    </>
  );
}
