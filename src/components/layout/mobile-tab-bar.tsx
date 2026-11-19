"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useParlayPool } from "@/components/parlay/parlay-pool-context";
import {
  LiveDot,
  MoreIcon,
  NAV_ITEMS,
  SlipBadge,
  isActiveHref,
  type NavItem,
} from "@/components/layout/nav-items";

// Below md only: the app's primary navigation as a bottom tab bar
// (Dashboard, Cappers, Live, Picks, More). Charts and Parlay Generator live in
// the More sheet. Everything comes from NAV_ITEMS, so the hrefs, icons, active
// logic and Live's dot match the header's tabs. From md the header nav (and
// the hamburger below 1024px) is unchanged and this renders nothing visible.
const TAB_HREFS = ["/dashboard", "/cappers", "/live", "/picks"];
const MORE_HREFS = ["/charts", "/parlay"];

function pick(hrefs: string[]): NavItem[] {
  return hrefs.map((href) => NAV_ITEMS.find((i) => i.href === href)).filter((i): i is NavItem => !!i);
}

// The bar looks the same in light and dark mode: the top header's navy (#0A1530, site-header.tsx)
// with no theme variants. The active tab is a raised blue pill (the selected league chip's gradient).
const TAB_BASE =
  "relative m-1 flex min-h-[48px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] leading-none transition-all duration-200 ease-out motion-reduce:transition-none ";
const TAB_ACTIVE =
  "-translate-y-0.5 bg-[linear-gradient(180deg,#3b82f6,#1d4ed8)] font-semibold text-white shadow-[0_6px_18px_rgba(37,99,235,.45),inset_0_1px_0_rgba(255,255,255,.35)]";
const TAB_IDLE = "font-medium text-slate-300";

export function MobileTabBar() {
  const pathname = usePathname();
  const { slipSize } = useParlayPool();
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetId = useId();
  const titleId = useId();
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const tabs = pick(TAB_HREFS);
  const moreItems = pick(MORE_HREFS);
  const moreActive = moreOpen || MORE_HREFS.some((href) => isActiveHref(pathname, href));

  // Close on navigation.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  // While open: Esc closes (focus back to More), body scroll is locked, Tab stays inside the sheet,
  // and focus moves into the sheet.
  useEffect(() => {
    if (!moreOpen) return;
    const button = moreButtonRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheetRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMoreOpen(false);
        return;
      }
      if (e.key !== "Tab" || !sheetRef.current) return;
      const focusable = Array.from(sheetRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || activeEl === sheetRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      button?.focus({ preventScroll: true });
    };
  }, [moreOpen]);

  return (
    <div className="md:hidden">
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-[#0A1530] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="grid grid-cols-5">
          {tabs.map((item) => {
            const Icon = item.icon;
            const active = isActiveHref(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={TAB_BASE + (active ? TAB_ACTIVE : TAB_IDLE)}
              >
                <span className="relative flex">
                  <Icon className="h-[22px] w-[22px]" />
                  {item.liveDot && <LiveDot ringClassName={active ? "border-[#2563eb]" : "border-[#0A1530]"} />}
                </span>
                {item.label}
              </Link>
            );
          })}
          <button
            ref={moreButtonRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-current={moreActive && !moreOpen ? "page" : undefined}
            aria-controls={moreOpen ? sheetId : undefined}
            onClick={() => setMoreOpen((v) => !v)}
            className={TAB_BASE + (moreActive ? TAB_ACTIVE : TAB_IDLE)}
          >
            <span className="relative flex">
              <MoreIcon className="h-[22px] w-[22px]" />
              {slipSize > 0 && !moreActive && (
                <span aria-hidden="true" className="absolute -right-[3px] -top-[3px] h-[9px] w-[9px] rounded-full border-2 border-[#0A1530] bg-brand-500" />
              )}
            </span>
            More
          </button>
        </div>
      </nav>

      {moreOpen && (
        <div className="fixed inset-0 z-50">
          <div aria-hidden="true" className="absolute inset-0 bg-[#050B1C]/50" onClick={() => setMoreOpen(false)} />
          <div
            ref={sheetRef}
            id={sheetId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="absolute inset-x-0 bottom-0 animate-sheet-up rounded-t-[20px] border-t border-[#E3E8F0] bg-white px-2 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-2 shadow-[0_-12px_40px_rgba(5,11,28,.28)] outline-none motion-reduce:animate-none dark:border-border dark:bg-card"
          >
            <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-[#D5DCE8] dark:bg-border" />
            <h2 id={titleId} className="sr-only">
              More
            </h2>
            {moreItems.map((item) => {
              const Icon = item.icon;
              const active = isActiveHref(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={
                    "flex min-h-[52px] w-full items-center gap-3 rounded-[12px] px-3 text-[16px] font-semibold transition " +
                    (active
                      ? "bg-[#EEF4FF] text-[#1747C9] dark:bg-brand-500/15 dark:text-brand-400"
                      : "text-[#2A3550] hover:bg-[#F3F6FB] dark:text-card-foreground dark:hover:bg-muted")
                  }
                >
                  <Icon className="h-[22px] w-[22px] shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {item.slipBadge && <SlipBadge count={slipSize} tone="card" />}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
