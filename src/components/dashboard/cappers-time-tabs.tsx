"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import { RANGE_OPTIONS, cappersHref, type CappersParams } from "@/lib/cappers-page-params";
import { BANNER_GROUP, BANNER_SEG, BANNER_SEG_OFF, BANNER_SEG_ON } from "@/components/dashboard/page-banner";

// The time range tabs in the /cappers banner: a dark pill group on ONE row that never wraps. When the
// card is too narrow for all five it scrolls sideways (no scrollbar) with the selected range scrolled
// into view; the selected range is lit blue. Links, so the range is a URL param the page reads on the
// server. scroll={false}: a soft navigation that swaps the data in place instead of jumping to the top.
export function CappersTimeTabs({ params }: { params: CappersParams }) {
  const nav = useRef<HTMLElement>(null);
  // Center the active pill by moving the strip itself (scrollIntoView would also scroll the page).
  useEffect(() => {
    const el = nav.current;
    const on = el?.querySelector<HTMLElement>("[aria-current]");
    if (!el || !on) return;
    el.scrollLeft = Math.max(0, on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2);
  }, [params.range]);
  return (
    <nav
      ref={nav}
      role="group"
      aria-label="Time range"
      className={BANNER_GROUP.replace("flex-wrap", "flex-nowrap") + " max-w-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"}
    >
      {RANGE_OPTIONS.map((r) => {
        const active = r.key === params.range;
        return (
          <Link
            key={r.key}
            href={cappersHref(params, { range: r.key })}
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={BANNER_SEG + (active ? BANNER_SEG_ON : BANNER_SEG_OFF)}
          >
            {r.pill}
          </Link>
        );
      })}
    </nav>
  );
}
