"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// The fade's width, and how far the row is padded so the last chip scrolls clear of it.
const FADE = 28;

// The banner's layout follows the card's width (a size container, see live-banner.tsx), written
// out as literal classes so Tailwind can see them:
//   under 640px      stacked, as on a phone: title, credit, league chips, then the controls
//   640px to 1110px  title and controls in one row, the leagues on a second, full-width row
//   from 1110px      one row, if it fits (see `stacked` below)
// Each `_WIDE` constant is its two-row one again for a card of 1110px or more, used when the single
// row does not fit.
const ROW = "[@container_(min-width:640px)]:flex [@container_(min-width:640px)]:items-center [@container_(min-width:640px)]:justify-between [@container_(min-width:640px)]:gap-x-5 [@container_(min-width:640px)]:pl-6 [@container_(min-width:640px)]:pr-7 [@container_(min-width:640px)_and_(max-width:1109.9px)]:flex-wrap";
const ROW_WIDE = " [@container_(min-width:1110px)]:flex-wrap";

const LEAGUES =
  "relative min-w-0 border-t border-[rgba(59,130,246,0.18)] [@container_(min-width:640px)]:border-t-0 " +
  "[@container_(min-width:640px)_and_(max-width:1109.9px)]:order-last [@container_(min-width:640px)_and_(max-width:1109.9px)]:w-full [@container_(min-width:640px)_and_(max-width:1109.9px)]:pb-4";
const LEAGUES_WIDE = " [@container_(min-width:1110px)]:order-last [@container_(min-width:1110px)]:w-full [@container_(min-width:1110px)]:pb-4";

// Under 640px: one row of separate chips that scrolls sideways. From there up: one segmented
// group. Either way it scrolls rather than wraps.
const NAV =
  "flex gap-2 overflow-x-auto pb-2 pl-3 pr-7 pt-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
  "[@container_(min-width:640px)]:gap-1 [@container_(min-width:640px)]:rounded-full [@container_(min-width:640px)]:border [@container_(min-width:640px)]:border-[rgba(96,140,255,0.2)] [@container_(min-width:640px)]:bg-[rgba(30,58,138,0.25)] [@container_(min-width:640px)]:p-1";
const CHIP =
  "flex h-8 flex-none items-center justify-center whitespace-nowrap rounded-full px-3.5 text-[12.5px] transition [@container_(max-width:639.9px)]:border " +
  "[@container_(min-width:640px)]:h-9 [@container_(min-width:640px)]:px-[18px] [@container_(min-width:640px)]:text-sm [@container_(min-width:640px)_and_(max-width:1109.9px)]:flex-1 ";
const CHIP_WIDE = "[@container_(min-width:1110px)]:flex-1 ";
const ACTIVE = "bg-[#2563EB] font-semibold text-white shadow-[0_0_14px_rgba(37,99,235,0.6)] [@container_(max-width:639.9px)]:border-[#2563EB]";
const INACTIVE = "font-medium text-[#D3DEFA] hover:text-white [@container_(max-width:639.9px)]:border-[rgba(96,140,255,0.28)] [@container_(max-width:639.9px)]:bg-[rgba(30,58,138,0.35)]";

const num = (s: string) => parseFloat(s) || 0;

// The /live banner's row: the title (`brand`), the league chips, then the controls (`children`).
// The leagues are plain links: the league, like the view, is a query param the page reads on the
// server.
export function LiveBannerRow({
  brand,
  leagues,
  active,
  children,
}: {
  brand: ReactNode;
  leagues: { key: string; label: string; href: string }[];
  active: string;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);
  // True when the three groups, at their own widths, are wider than the row. The 1110px in the
  // classes is where they fit with the Parlay slip at rest; its count, Confirm button and discard
  // prompt make the controls wider, which only measuring can tell.
  const [stacked, setStacked] = useState(false);

  useEffect(() => {
    const row = rowRef.current;
    const nav = navRef.current;
    const first = row?.firstElementChild;
    const last = row?.lastElementChild;
    if (!row || !nav || !first || !last) return;
    const measure = () => {
      const r = getComputedStyle(row);
      const n = getComputedStyle(nav);
      // The group's own width: a chip in the full-width row is stretched, its label is not.
      let group = num(n.paddingLeft) + num(n.paddingRight) + num(n.borderLeftWidth) + num(n.borderRightWidth) + (nav.children.length - 1) * num(n.columnGap);
      for (const chip of Array.from(nav.children)) {
        const c = getComputedStyle(chip);
        group += (chip.firstElementChild?.getBoundingClientRect().width ?? 0) + num(c.paddingLeft) + num(c.paddingRight);
      }
      const need = first.getBoundingClientRect().width + group + last.getBoundingClientRect().width + 2 * num(r.columnGap);
      setStacked(need > row.clientWidth - num(r.paddingLeft) - num(r.paddingRight) + 0.5);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(first);
    observer.observe(last);
    return () => observer.disconnect();
  }, []);

  // Keep the selected chip in view in the scrolling row. Only the row moves: scrollIntoView could
  // also scroll the page.
  useEffect(() => {
    const nav = navRef.current;
    const chip = activeRef.current;
    if (!nav || !chip) return;
    const n = nav.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    const left = n.left + parseFloat(getComputedStyle(nav).paddingLeft);
    if (c.left < left) nav.scrollLeft += c.left - left;
    else if (c.right > n.right - FADE) nav.scrollLeft += c.right - n.right + FADE;
  }, [active]);

  return (
    <div ref={rowRef} className={ROW + (stacked ? ROW_WIDE : "")}>
      {brand}
      <div className={LEAGUES + (stacked ? LEAGUES_WIDE : "")}>
        <nav ref={navRef} aria-label="League" className={NAV}>
          {leagues.map((l) => {
            const on = l.key === active;
            return (
              <a key={l.key} ref={on ? activeRef : undefined} href={l.href} aria-current={on ? "page" : undefined} className={CHIP + (stacked ? CHIP_WIDE : "") + (on ? ACTIVE : INACTIVE)}>
                <span>{l.label}</span>
              </a>
            );
          })}
        </nav>
        {/* Hints that the row scrolls: fades into the banner's background. */}
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-r from-transparent to-[#011948] [@container_(min-width:640px)]:hidden" />
      </div>
      {children}
    </div>
  );
}
