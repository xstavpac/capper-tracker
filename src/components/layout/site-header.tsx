"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LightningIcon } from "@/components/dashboard/drop-catalog-button";
import { useParlayPool } from "@/components/parlay/parlay-pool-context";
import { HeaderMenu, type HeaderUser } from "@/components/layout/header-menu";
import { SHELL_CONTAINER } from "@/components/layout/shell";
import { LiveDot, NAV_ITEMS, SlipBadge, isActiveHref } from "@/components/layout/nav-items";

// The logo's mark (the "B" and chevron) cropped from the full lockup in
// /logo-mark.png (1690x470, mark at x 22-480), on a white tile so its navy and
// blue keep their real colors on the navy bar. Drawn 32px tall, the mark ends
// about 33px across.
function LogoMark() {
  return (
    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white max-[419px]:h-10 max-[419px]:w-10">
      <span className="block h-[21px] w-[22px] overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- fixed local asset, not worth next/image's overhead at this size */}
        <img src="/logo-mark.png" alt="" className="h-[21px] w-auto max-w-none" />
      </span>
    </span>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

// Tab sizes by width (the tabs are hidden below 1024px): 40px tall, 15px/600, 14px side padding, 16px icons,
// 10px radius, 4px between tabs. 1024-1279px steps down to 14px text and 10px side padding so the header
// stays one row from 1024px.
const TAB =
  "relative flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] px-3.5 text-[15px] font-semibold transition lg:max-xl:gap-1.5 lg:max-xl:px-2.5 lg:max-xl:text-[14px] ";
const TAB_ICON = "h-4 w-4";
const NAV_GAP = "gap-1 xl:gap-[22px]";
const TAB_IDLE = "text-[#C9D3E6] hover:bg-white/5 hover:text-white";
const TAB_ACTIVE = "bg-[#2563EB] text-white";

// The app's top bar: logo, the nav tabs (from 1024px), Drop Catalog and the
// hamburger menu. Navy in both themes. Takes only what the (app) layout
// already loads - no data of its own.
export function SiteHeader({
  user,
  showAdminOps = false,
  reviewCount = 0,
  slate,
  slateChips,
}: {
  user: HeaderUser;
  showAdminOps?: boolean;
  // Pending Telegram-ingest review items; a badge on Drop Catalog (the link to the Catalog Import page).
  reviewCount?: number;
  // The Slate Bar: rendered under the header row, on the header's own navy background.
  slate?: ReactNode;
  // From 1024px: the league chips alone, a row under the nav column (the container is a grid from lg).
  slateChips?: ReactNode;
}) {
  const pathname = usePathname();
  const { slipSize } = useParlayPool();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const avatarRef = useRef<HTMLButtonElement>(null);
  const triggerWrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on a route change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on a click outside the menu and its button, or on Esc (focus back to the button).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerWrapRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      // The hamburger (md+) or the avatar (below md), whichever is showing.
      (buttonRef.current?.offsetParent ? buttonRef.current : avatarRef.current)?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <header className="relative z-40 bg-[#0A1530] lg:pb-4">
    <div className={SHELL_CONTAINER + " relative flex flex-wrap items-center gap-x-6 gap-y-3 py-3 max-sm:flex-nowrap max-sm:gap-x-3 max-[419px]:gap-x-2 max-[379px]:pl-3 max-[379px]:pr-3 lg:grid lg:grid-cols-[auto_1fr_auto]"}>
      <Link href="/dashboard" aria-label="BettingView" className="flex min-w-0 items-center gap-2.5 rounded-xl max-[379px]:gap-2 sm:shrink-0">
        <LogoMark />
        {/* Below 1024px (where the Slate Bar shows): the greeting, one row beside Drop Catalog and the avatar (both
            shrink-0); it takes the room that is left and truncates with an ellipsis. From 1024px: the original wordmark,
            hidden at 1024-1279px where the tabs need the room. */}
        <span className="min-w-0 whitespace-nowrap text-[16px] font-bold text-white max-[419px]:text-[15px] max-[349px]:overflow-hidden max-[349px]:text-ellipsis sm:text-[18px] lg:hidden">Welcome back!</span>
        <span className="hidden whitespace-nowrap text-[18px] font-bold text-white xl:inline">BettingView</span>
      </Link>

      {/* From 1024px, in the header's single row (see TAB for the sizes per width). The nav fills the space between the logo and the right-hand buttons and centers the tab group in it.
          The header's 24px gap plus ml-4 / mr-2 keeps at least 40px after the logo and 32px before Drop Catalog. */}
      <nav aria-label="Main" className={"hidden items-center lg:ml-4 lg:mr-2 lg:flex lg:flex-1 lg:justify-center " + NAV_GAP}>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isActiveHref(pathname, item.href);
          return (
            <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={TAB + (active ? TAB_ACTIVE : TAB_IDLE)}>
              <span className="relative flex">
                <Icon className={TAB_ICON} />
                {item.liveDot && <LiveDot ringClassName={active ? "border-[#2563EB]" : "border-[#0A1530]"} />}
              </span>
              {item.label}
              {item.slipBadge && <SlipBadge count={slipSize} tone="bar" />}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-3 max-[419px]:gap-2">
        {/* Below 640px: the bolt and the full label, 14px (plus the badge). 1024-1279px: the bolt and "Catalog", 14px.
            From 1280px: 15px. The link's accessible name is always the full one. */}
        <a
          href="/picks/import"
          aria-label={"Drop Catalog" + (reviewCount > 0 ? ", " + reviewCount + " to review" : "")}
          className="flex h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] bg-[#7C3AED] px-3.5 text-[15px] max-[419px]:gap-[5px] max-[419px]:px-3 max-[379px]:px-2.5 font-bold text-white transition animate-glow-pulse-compact hover:bg-[#6D28D9] motion-reduce:animate-none sm:px-4 lg:max-xl:px-3 lg:max-xl:text-[14px]"
        >
          {/* Hidden below 380px so the greeting fits in full beside the button (the review badge stays). */}
          <span className="contents max-[379px]:hidden">
            <LightningIcon />
          </span>
          <span aria-hidden="true" className="whitespace-nowrap text-[14px] max-[419px]:text-[13px] sm:text-[15px] lg:max-xl:text-[14px]">
            <span className="lg:max-xl:hidden">Drop </span>Catalog
          </span>
          {reviewCount > 0 && (
            <span
              aria-hidden="true"
              className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-white px-1.5 text-[11px] font-semibold text-[#6D28D9]"
            >
              {reviewCount}
            </span>
          )}
        </a>

        <div ref={triggerWrapRef} className="contents">
        {/* Below 768px: the account avatar (the page links are in the bottom tab bar). */}
        <button
          ref={avatarRef}
          type="button"
          aria-label="Account menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((v) => !v)}
          className={
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500 max-[419px]:h-[38px] max-[419px]:w-[38px] text-[15px] font-semibold text-white transition hover:bg-brand-600 md:hidden " +
            (open ? "ring-2 ring-white/60" : "")
          }
        >
          <span aria-hidden="true">{(user.name ?? user.email).charAt(0).toUpperCase()}</span>
        </button>

        <button
          ref={buttonRef}
          type="button"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((v) => !v)}
          className={
            "hidden h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[#2A3A60] text-[#C9D3E6] transition hover:bg-white/5 hover:text-white md:flex " +
            (open ? "bg-white/10 text-white" : "")
          }
        >
          <MenuIcon />
        </button>
        </div>
      </div>

      {slateChips && <div className="hidden lg:col-start-2 lg:block">{slateChips}</div>}

      {open && <HeaderMenu ref={menuRef} id={menuId} user={user} showAdminOps={showAdminOps} slipSize={slipSize} onNavigate={() => setOpen(false)} />}
    </div>
    {slate}
    </header>
  );
}
