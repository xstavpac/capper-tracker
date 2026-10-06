"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { LiveIcon } from "@/components/dashboard/cappers-icons";

// The fade's width, and how far the row is padded so the last chip scrolls clear of it.
const FADE = 28;

const CREDIT = "Powered by The Odds API";

// A segment's side padding and text size, in px, in the full row and in the compact one. The
// classes below say the same (--seg-px, --seg-text); these are for measuring.
const FULL = { px: 18, font: 14 };
const COMPACT = { px: 12, font: 13 };

// The banner's layout follows the card's width (a size container, see live-banner.tsx):
//   under 640px      stacked, as on a phone: title, credit, league chips, then the controls
//   640px to 864px   two rows: title and controls, then the leagues at full width
//   864px to 1110px  one compact row: no credit, narrower segments
//   from 1110px      one full row
// 864px and 1110px are where the compact and the full row fit with the Parlay slip at rest. Its
// count, Confirm button and discard prompt make the controls wider, which only measuring can tell
// (`tier` below), so each step down is written out twice, as literal classes Tailwind can see: once
// for its own range of widths, and once for a wider card that has to take it anyway.
const ROW =
  "[@container_(min-width:640px)]:flex [@container_(min-width:640px)]:items-center [@container_(min-width:640px)]:justify-between [@container_(min-width:640px)]:gap-x-5 [@container_(min-width:640px)]:pl-6 [@container_(min-width:640px)]:pr-7 " +
  "[@container_(min-width:640px)_and_(max-width:863.9px)]:flex-wrap";
const ROW_TWO = " [@container_(min-width:640px)]:flex-wrap";
const ROW_COMPACT = " [@container_(min-width:864px)_and_(max-width:1109.9px)]:[--seg-px:12px] [@container_(min-width:864px)_and_(max-width:1109.9px)]:[--seg-text:13px]";
const ROW_COMPACT_WIDE = " [@container_(min-width:1110px)]:[--seg-px:12px] [@container_(min-width:1110px)]:[--seg-text:13px]";

// Stacked, the line sits in what is left of the first column, between the ring and the word.
const BRAND =
  "relative grid grid-cols-[1fr_auto_1fr] [@container_(min-width:640px)]:h-[84px] [@container_(min-width:640px)]:flex-none [@container_(min-width:640px)]:grid-cols-[auto_auto] [@container_(min-width:640px)]:content-center [@container_(min-width:640px)]:gap-y-1.5";
const CREDIT_TEXT =
  "col-span-3 whitespace-nowrap pb-2.5 text-center text-[9.5px] font-bold uppercase tracking-[2px] text-[#BFD3FF] " +
  "[@container_(min-width:640px)]:col-span-1 [@container_(min-width:640px)]:col-start-2 [@container_(min-width:640px)]:pb-0 [@container_(min-width:640px)]:text-left [@container_(min-width:640px)]:text-[10px] [@container_(min-width:640px)]:tracking-[2.4px]";
const CREDIT_COMPACT = " [@container_(min-width:864px)_and_(max-width:1109.9px)]:sr-only";
const CREDIT_COMPACT_WIDE = " [@container_(min-width:1110px)]:sr-only";
// The blue light on a stacked card's edges, over the title's rows only (see live-banner.tsx).
const GLOW = "pointer-events-none absolute inset-y-0 w-[70px] [@container_(min-width:640px)]:hidden ";

const LEAGUES =
  "relative min-w-0 border-t border-[rgba(59,130,246,0.18)] [@container_(min-width:640px)]:border-t-0 " +
  "[@container_(min-width:640px)_and_(max-width:863.9px)]:order-last [@container_(min-width:640px)_and_(max-width:863.9px)]:w-full [@container_(min-width:640px)_and_(max-width:863.9px)]:pb-4";
const LEAGUES_TWO = " [@container_(min-width:640px)]:order-last [@container_(min-width:640px)]:w-full [@container_(min-width:640px)]:pb-4";

// Under 640px: one row of separate chips that scrolls sideways. From there up: one segmented
// group. Either way it scrolls rather than wraps.
const NAV =
  "flex gap-2 overflow-x-auto pb-2 pl-3 pr-7 pt-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
  "[@container_(min-width:640px)]:gap-1 [@container_(min-width:640px)]:rounded-full [@container_(min-width:640px)]:border [@container_(min-width:640px)]:border-[rgba(96,140,255,0.2)] [@container_(min-width:640px)]:bg-[rgba(30,58,138,0.25)] [@container_(min-width:640px)]:p-1";
const SIZE = "[@container_(min-width:640px)]:h-9 [@container_(min-width:640px)]:px-[var(--seg-px,18px)] [@container_(min-width:640px)]:text-[length:var(--seg-text,14px)] ";
const CHIP =
  "flex h-8 flex-none items-center justify-center whitespace-nowrap rounded-full px-3.5 text-[12.5px] transition [@container_(max-width:639.9px)]:border " +
  SIZE +
  "[@container_(min-width:640px)_and_(max-width:863.9px)]:flex-1 ";
const CHIP_TWO = "[@container_(min-width:640px)]:flex-1 ";
const ON = "bg-[#2563EB] font-semibold text-white shadow-[0_0_14px_rgba(37,99,235,0.6)] ";
const OFF = "font-medium text-[#D3DEFA] hover:text-white ";
const CHIP_ON = ON + "[@container_(max-width:639.9px)]:border-[#2563EB]";
const CHIP_OFF = OFF + "[@container_(max-width:639.9px)]:border-[rgba(96,140,255,0.28)] [@container_(max-width:639.9px)]:bg-[rgba(30,58,138,0.35)]";

const CONTROLS = "flex flex-wrap items-center justify-between gap-x-2 gap-y-2 px-3 pb-3 pt-1 [@container_(min-width:640px)]:ml-auto [@container_(min-width:640px)]:flex-none [@container_(min-width:640px)]:gap-3 [@container_(min-width:640px)]:p-0";
const VIEWS = "flex flex-none rounded-full border border-[rgba(96,140,255,0.2)] bg-[rgba(30,58,138,0.25)] p-[3px] [@container_(min-width:640px)]:gap-1 [@container_(min-width:640px)]:p-1";
const SEGMENT = "flex h-7 items-center whitespace-nowrap rounded-full px-3.5 text-[12.5px] transition " + SIZE;

type Tab = { key: string; label: string; href: string };

const num = (s: string) => parseFloat(s) || 0;

// The /live banner's content: the title, the league chips, then the view toggle and the Parlay
// slip (`children`). The leagues and the views are plain links: both are query params the page
// reads on the server.
export function LiveBannerRow({ leagues, league, views, view, children }: { leagues: Tab[]; league: string; views: Tab[]; view: string; children: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const creditRef = useRef<HTMLParagraphElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const viewsRef = useRef<HTMLElement>(null);
  // The widest row that fits, measured. Until then the classes go by the card's width alone.
  const [tier, setTier] = useState<"full" | "compact" | "two" | null>(null);

  useEffect(() => {
    const row = rowRef.current;
    const ring = ringRef.current;
    const title = titleRef.current;
    const credit = creditRef.current;
    const nav = navRef.current;
    const controls = controlsRef.current;
    const viewsNav = viewsRef.current;
    if (!row || !ring || !title || !credit || !nav || !controls || !viewsNav) return;

    // A label's width per px of text size, kept so every tier measures the same whichever one is
    // showing: the labels are drawn at the current tier's size.
    const unit = new Map<Element, number>();
    const groupWidth = (group: HTMLElement, size: { px: number; font: number }) => {
      const g = getComputedStyle(group);
      let width = num(g.paddingLeft) + num(g.paddingRight) + num(g.borderLeftWidth) + num(g.borderRightWidth) + (group.children.length - 1) * num(g.columnGap);
      for (const segment of Array.from(group.children)) {
        const label = segment.firstElementChild;
        if (!label) continue;
        let u = unit.get(label);
        if (u === undefined) {
          u = label.getBoundingClientRect().width / num(getComputedStyle(label).fontSize);
          unit.set(label, u);
        }
        width += u * size.font + 2 * size.px;
      }
      return width;
    };
    const measure = () => {
      const r = getComputedStyle(row);
      const room = row.clientWidth - num(r.paddingLeft) - num(r.paddingRight) + 0.5;
      const ringWidth = ring.getBoundingClientRect().width;
      const titleWidth = title.getBoundingClientRect().width;
      // Everything in the controls but the view toggle: the Parlay slip, whatever it is showing.
      const rest = controls.getBoundingClientRect().width - viewsNav.getBoundingClientRect().width + 2 * num(r.columnGap);
      // The credit is one unwrapped line, so its scroll width is its text's, hidden or not.
      const full = ringWidth + Math.max(titleWidth, credit.scrollWidth) + groupWidth(nav, FULL) + groupWidth(viewsNav, FULL) + rest;
      const compact = ringWidth + titleWidth + groupWidth(nav, COMPACT) + groupWidth(viewsNav, COMPACT) + rest;
      setTier(full <= room ? "full" : compact <= room ? "compact" : "two");
    };
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(controls);
    // The page's typeface swaps in after the first paint, and is not as wide as the fallback.
    let live = true;
    document.fonts.ready.then(() => {
      if (!live) return;
      unit.clear();
      measure();
    });
    return () => {
      live = false;
      observer.disconnect();
    };
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
  }, [league]);

  const two = tier === "two";
  // A card in the compact row's range shows it unless measuring says two rows; a wider card only
  // when measuring says compact.
  const wide = tier === "compact";

  return (
    <div ref={rowRef} className={ROW + (two ? ROW_TWO : "") + (two ? "" : ROW_COMPACT) + (wide ? ROW_COMPACT_WIDE : "")}>
      <div className={BRAND}>
        <div ref={ringRef} className="flex h-[52px] items-center [@container_(min-width:640px)]:row-span-2 [@container_(min-width:640px)]:h-auto [@container_(min-width:640px)]:pr-4">
          {/* The credit is still here when the compact row has no room for its line. */}
          <span
            title={CREDIT}
            className="relative ml-4 flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full border-2 border-[#3B82F6] bg-[rgba(3,11,41,0.6)] text-[#9AD8FF] shadow-[0_0_14px_rgba(59,130,246,0.75),inset_0_0_10px_rgba(59,130,246,0.45)] [@container_(min-width:640px)]:ml-0 [@container_(min-width:640px)]:h-11 [@container_(min-width:640px)]:w-11"
          >
            <LiveIcon className="h-[18px] w-[18px] [@container_(min-width:640px)]:h-[22px] [@container_(min-width:640px)]:w-[22px]" />
            <span aria-hidden className="absolute -right-0.5 -top-0.5 h-[9px] w-[9px] rounded-full border-2 border-[#011948] bg-[#EF4444] shadow-[0_0_7px_rgba(239,68,68,0.9)] [@container_(min-width:640px)]:h-[11px] [@container_(min-width:640px)]:w-[11px]" />
          </span>
          <span aria-hidden className="flex flex-1 justify-center [@container_(min-width:640px)]:ml-4 [@container_(min-width:640px)]:flex-none">
            <span className="h-[26px] w-0.5 rounded-full bg-[#22D3EE] shadow-[0_0_6px_rgba(34,211,238,0.8)] [@container_(min-width:640px)]:h-8" />
          </span>
        </div>
        <h1 ref={titleRef} className="self-center text-[34px] font-extrabold leading-none tracking-[-0.8px] text-white [text-shadow:0_0_14px_rgba(96,165,250,0.55)]">
          Live
        </h1>
        <p ref={creditRef} className={CREDIT_TEXT + (two ? "" : CREDIT_COMPACT) + (wide ? CREDIT_COMPACT_WIDE : "")}>
          {CREDIT}
        </p>
        <span aria-hidden className={GLOW + "left-0 bg-[linear-gradient(270deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.2)_70%,rgba(56,189,248,0.38)_100%)]"} />
        <span aria-hidden className={GLOW + "right-0 bg-[linear-gradient(90deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.2)_70%,rgba(56,189,248,0.38)_100%)]"} />
      </div>

      <div className={LEAGUES + (two ? LEAGUES_TWO : "")}>
        <nav ref={navRef} aria-label="League" className={NAV}>
          {leagues.map((l) => {
            const on = l.key === league;
            return (
              <a key={l.key} ref={on ? activeRef : undefined} href={l.href} aria-current={on ? "page" : undefined} className={CHIP + (two ? CHIP_TWO : "") + (on ? CHIP_ON : CHIP_OFF)}>
                <span>{l.label}</span>
              </a>
            );
          })}
        </nav>
        {/* Hints that the row scrolls: fades into the banner's background. */}
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-r from-transparent to-[#011948] [@container_(min-width:640px)]:hidden" />
      </div>

      <div ref={controlsRef} className={CONTROLS}>
        <nav ref={viewsRef} aria-label="View" className={VIEWS}>
          {views.map((v) => (
            <a key={v.key} href={v.href} aria-current={v.key === view ? "page" : undefined} className={SEGMENT + (v.key === view ? ON : OFF)}>
              <span>{v.label}</span>
            </a>
          ))}
        </nav>
        {children}
      </div>
    </div>
  );
}
