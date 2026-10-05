"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { RANGE_OPTIONS, cappersHref, type CappersParams } from "@/lib/cappers-page-params";

// The fade's width, and how far the row is padded so the last chip scrolls clear of it.
const FADE = 28;

// On a phone: one row of separate chips that scrolls sideways. From `sm` up: one pill-shaped
// segmented group. The phone's row is a scroll container, which clips: its padding (cancelled by
// the negative margins) is the room the selected chip's glow needs.
const ROW =
  "flex gap-2 max-sm:-mb-3 max-sm:-ml-3 max-sm:-mt-2.5 max-sm:snap-x max-sm:scroll-pl-3 max-sm:overflow-x-auto max-sm:pb-3 max-sm:pl-3 max-sm:pr-7 max-sm:pt-2.5max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden " +
  "sm:inline-flex sm:max-w-full sm:flex-wrap sm:gap-1.5 sm:rounded-full sm:border sm:border-[rgba(96,140,255,0.2)] sm:bg-[rgba(30,58,138,0.25)] sm:p-1";
const CHIP =
  "flex h-8 flex-none items-center whitespace-nowrap rounded-full px-[13px] text-[12.5px] font-medium capitalize transition max-sm:snap-start max-sm:border sm:px-3.5 ";
const ACTIVE = "bg-[#2563EB] text-white shadow-[0_0_14px_rgba(37,99,235,0.6)] max-sm:border-[#2563EB]";
const INACTIVE = "text-[#D3DEFA] hover:text-white max-sm:border-[rgba(96,140,255,0.2)] max-sm:bg-[rgba(30,58,138,0.25)]";

// The time range chips in the /cappers banner (dark in both themes).
// scroll={false}: a soft navigation that swaps the data in place instead of jumping to the top.
export function CappersTimeTabs({ params }: { params: CappersParams }) {
  const navRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);

  // Keep the selected chip in view in the phone's scrolling row. Only the row moves: scrollIntoView
  // would also scroll the page up to the banner when the range changes from further down (back button).
  useEffect(() => {
    const nav = navRef.current;
    const chip = activeRef.current;
    if (!nav || !chip) return;
    const n = nav.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    const left = n.left + parseFloat(getComputedStyle(nav).paddingLeft);
    if (c.left < left) nav.scrollLeft += c.left - left;
    else if (c.right > n.right - FADE) nav.scrollLeft += c.right - n.right + FADE;
  }, [params.range]);

  return (
    <div className="relative min-w-0 max-sm:w-full sm:flex">
      <nav ref={navRef} aria-label="Time range" className={ROW}>
        {RANGE_OPTIONS.map((r) => {
          const active = r.key === params.range;
          return (
            <Link
              key={r.key}
              ref={active ? activeRef : undefined}
              href={cappersHref(params, { range: r.key })}
              scroll={false}
              aria-current={active ? "page" : undefined}
              className={CHIP + (active ? ACTIVE : INACTIVE)}
            >
              {r.label}
            </Link>
          );
        })}
      </nav>
      {/* Hints that the row scrolls: fades into the banner's background. */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-r from-transparent to-[#011948] sm:hidden" />
    </div>
  );
}
