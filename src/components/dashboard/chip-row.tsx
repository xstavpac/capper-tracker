"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";

export type Chip = { key: string; label: string; href: string; active: boolean };

// The fade's width, and how far the row is padded so the last chip scrolls clear of it.
const FADE = 28;

// A row of filter chips (same pills as the Cappers-page bet-type chips). On a phone: one line that
// scrolls sideways under a right fade, the pattern of the /cappers time tabs; from `sm` up it wraps.
// The phone's row is a scroll container, which clips: its vertical padding (cancelled by the
// negative margin) is the room the chips' shadow needs.
// scroll={false}: a soft navigation that swaps the data in place instead of jumping to the top.
export function ChipRow({ label, chips }: { label: string; chips: Chip[] }) {
  const navRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);
  const activeKey = chips.find((c) => c.active)?.key;

  // Keep the selected chip in view in the phone's scrolling row. Only the row moves: scrollIntoView
  // would also scroll the page.
  useEffect(() => {
    const nav = navRef.current;
    const chip = activeRef.current;
    if (!nav || !chip) return;
    const n = nav.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    if (c.left < n.left) nav.scrollLeft += c.left - n.left;
    else if (c.right > n.right - FADE) nav.scrollLeft += c.right - n.right + FADE;
  }, [activeKey]);

  return (
    <div className="relative min-w-0">
      <nav
        ref={navRef}
        aria-label={label}
        className="flex gap-2 max-sm:-my-1 max-sm:overflow-x-auto max-sm:py-1 max-sm:pl-0.5 max-sm:pr-7 max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden sm:flex-wrap"
      >
        {chips.map((chip) => (
          <Link
            key={chip.key}
            ref={chip.active ? activeRef : undefined}
            href={chip.href}
            scroll={false}
            aria-current={chip.active ? "page" : undefined}
            className={
              "flex-none whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium " +
              (chip.active
                ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                : "bg-card text-muted-foreground shadow-soft hover:bg-muted")
            }
          >
            {chip.label}
          </Link>
        ))}
      </nav>
      {/* Hints that the row scrolls: fades into the page background. */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-r from-transparent to-background sm:hidden" />
    </div>
  );
}
