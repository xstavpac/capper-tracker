"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LightningIcon } from "@/components/dashboard/drop-catalog-button";
import { useParlayPool } from "@/components/parlay/parlay-pool-context";
import { HeaderMenu, type HeaderUser } from "@/components/layout/header-menu";
import { LiveDot, NAV_ITEMS, SlipBadge, isActiveHref } from "@/components/layout/nav-items";

// The logo's mark (the "B" and chevron) cropped from the full lockup in
// /logo-mark.png (1690x470, mark at x 22-480), on a white tile so its navy and
// blue keep their real colors on the navy bar. Drawn 32px tall, the mark ends
// about 33px across.
function LogoMark() {
  return (
    <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-white">
      <span className="block h-[26px] w-[27px] overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- fixed local asset, not worth next/image's overhead at this size */}
        <img src="/logo-mark.png" alt="" className="h-[26px] w-auto max-w-none" />
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

// Tab sizes by width, as three non-overlapping ranges (the tabs are hidden below 1024px):
//   1024-1279px  14px, 10px side padding, 4px gaps, 16px icons
//   1280-1479px  15px, 14px side padding, 6px gaps, 16px icons
//   from 1480px  17px, 20px side padding, 8px gaps, 18px icons
// so the header stays one row at every width from 1024px.
const TAB =
  "relative flex h-12 shrink-0 items-center whitespace-nowrap rounded-xl font-semibold transition gap-2 px-5 text-[17px] " +
  "lg:max-xl:gap-1 lg:max-xl:px-2.5 lg:max-xl:text-[14px] xl:max-[1479.9px]:gap-1.5 xl:max-[1479.9px]:px-3.5 xl:max-[1479.9px]:text-[15px] ";
const TAB_ICON = "h-[18px] w-[18px] lg:max-[1479.9px]:h-4 lg:max-[1479.9px]:w-4";
const NAV_GAP = "gap-2 lg:max-xl:gap-1 xl:max-[1479.9px]:gap-1.5";
const TAB_IDLE = "text-[#C9D3E6] hover:bg-white/5 hover:text-white";
const TAB_ACTIVE = "bg-[#2563EB] text-white";

// The app's top bar: logo, the nav tabs (from 1024px), Drop Catalog and the
// hamburger menu. Navy in both themes. Takes only what the (app) layout
// already loads - no data of its own.
export function SiteHeader({
  user,
  showAdminOps = false,
  reviewCount = 0,
}: {
  user: HeaderUser;
  showAdminOps?: boolean;
  // Pending Telegram-ingest review items; a badge on Drop Catalog (the link to the Catalog Import page).
  reviewCount?: number;
}) {
  const pathname = usePathname();
  const { slipSize } = useParlayPool();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
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
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <header className="relative z-40 flex flex-wrap items-center gap-x-4 gap-y-3 bg-[#0A1530] px-6 py-[14px] lg:flex-nowrap">
      <Link href="/dashboard" className="flex shrink-0 items-center gap-2.5 rounded-xl">
        <LogoMark />
        {/* 1024-1279px: the tile only. 1280-1479px: 18px. */}
        <span className="whitespace-nowrap text-[20px] font-bold text-white lg:max-xl:hidden xl:max-[1479.9px]:text-[18px]">BettingView</span>
      </Link>

      {/* From 1024px, in the header's single row (see TAB for the sizes per width). */}
      <nav aria-label="Main" className={"hidden items-center lg:flex " + NAV_GAP}>
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

      <div className="ml-auto flex items-center gap-3">
        {/* Below 640px: the bolt only (plus the badge). 1024-1279px: the bolt and "Catalog", 14px.
            1280-1479px: 15px. The link's accessible name is always the full one. */}
        <a
          href="/picks/import"
          aria-label={"Drop Catalog" + (reviewCount > 0 ? ", " + reviewCount + " to review" : "")}
          className="flex h-12 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-[#7C3AED] px-3.5 text-[17px] font-bold text-white transition animate-glow-pulse-compact hover:bg-[#6D28D9] motion-reduce:animate-none sm:px-5 lg:max-xl:px-3 lg:max-xl:text-[14px] xl:max-[1479.9px]:px-4 xl:max-[1479.9px]:text-[15px]"
        >
          <LightningIcon />
          <span aria-hidden="true" className="hidden sm:inline">
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

        <button
          ref={buttonRef}
          type="button"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((v) => !v)}
          className={
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[#2A3A60] text-[#C9D3E6] transition hover:bg-white/5 hover:text-white " +
            (open ? "bg-white/10 text-white" : "")
          }
        >
          <MenuIcon />
        </button>
      </div>

      {open && <HeaderMenu ref={menuRef} id={menuId} user={user} showAdminOps={showAdminOps} slipSize={slipSize} onNavigate={() => setOpen(false)} />}
    </header>
  );
}
