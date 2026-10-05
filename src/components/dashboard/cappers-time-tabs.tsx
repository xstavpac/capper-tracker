"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { RANGE_OPTIONS, cappersHref, type CappersParams } from "@/lib/cappers-page-params";
import { PILL_GROUP, pill } from "@/components/dashboard/page-header-bar";

// The fade's width, and how far the row is padded so the last chip scrolls clear of it.
const FADE = 28;

// On a phone the group becomes one row of separate chips that scrolls sideways.
const MOBILE_ROW =
  " max-sm:flex-nowrap max-sm:gap-2 max-sm:snap-x max-sm:overflow-x-auto max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent max-sm:p-0 max-sm:pr-7 max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden";
const MOBILE_CHIP = " max-sm:flex max-sm:h-[34px] max-sm:flex-none max-sm:snap-start max-sm:items-center max-sm:rounded-full max-sm:border max-sm:px-3.5 max-sm:py-0 ";

// The pill group in the /cappers banner (dark in both themes).
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
    if (c.left < n.left) nav.scrollLeft += c.left - n.left;
    else if (c.right > n.right - FADE) nav.scrollLeft += c.right - n.right + FADE;
  }, [params.range]);

  return (
    // sm:contents: from `sm` up the wrapper is not a box, so the nav sits in the banner as before.
    <div className="relative w-full min-w-0 sm:contents">
      <nav ref={navRef} aria-label="Time range" className={PILL_GROUP + " xl:mx-auto" + MOBILE_ROW}>
        {RANGE_OPTIONS.map((r) => {
          const active = r.key === params.range;
          return (
            <Link
              key={r.key}
              ref={active ? activeRef : undefined}
              href={cappersHref(params, { range: r.key })}
              scroll={false}
              aria-current={active ? "page" : undefined}
              className={pill(active) + " px-[7px] capitalize min-[1700px]:px-3.5" + MOBILE_CHIP + (active ? "max-sm:border-brand-600" : "max-sm:border-[#263048] max-sm:bg-[#1A2236]")}
            >
              {r.label}
            </Link>
          );
        })}
      </nav>
      {/* Hints that the row scrolls: fades into the banner's background. */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-r from-transparent to-[#0F1420] sm:hidden" />
    </div>
  );
}
