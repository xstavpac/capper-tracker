"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { dropCatalogButtonBaseClass, LightningIcon } from "@/components/dashboard/drop-catalog-button";
import { clearParlaySlips, useParlayPool } from "@/components/parlay/parlay-pool-context";

type SidebarUser = { name: string | null; email: string; profilePictureUrl: string | null };

function iconProps(className?: string) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: className ?? "h-[18px] w-[18px]",
    "aria-hidden": true,
  };
}

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <rect x="4" y="4" width="7" height="9" rx="1.5" />
      <rect x="13" y="4" width="7" height="5" rx="1.5" />
      <rect x="13" y="11" width="7" height="9" rx="1.5" />
      <rect x="4" y="15" width="7" height="5" rx="1.5" />
    </svg>
  );
}

// Crown (lucide "Crown" geometry - the project doesn't depend on lucide, so
// it's inlined like the rest of these).
function CappersIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
      <path d="M5 21h14" />
    </svg>
  );
}

// lucide "SkipForward" geometry - gives Skipped Lines its own glyph instead
// of sharing Settings' gear.
function SkippedLinesIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M5 4l10 8l-10 8z" />
      <path d="M19 5v14" />
    </svg>
  );
}

function PicksIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M3.5 5.5l1.3 1.3l2.2 -2.3" />
      <path d="M3.5 12.5l1.3 1.3l2.2 -2.3" />
      <path d="M3.5 19.5l1.3 1.3l2.2 -2.3" />
      <path d="M11 6h9.5" />
      <path d="M11 13h9.5" />
      <path d="M11 20h9.5" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function LiveIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <path d="M9.2 9.2a4 4 0 0 0 0 5.6" />
      <path d="M14.8 9.2a4 4 0 0 1 0 5.6" />
      <path d="M6.5 6.5a8 8 0 0 0 0 11" />
      <path d="M17.5 6.5a8 8 0 0 1 0 11" />
    </svg>
  );
}

function ParlayIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M4 6.5l6 5.5l-6 5.5" />
      <path d="M11 6.5h9" />
      <path d="M11 17.5h9" />
    </svg>
  );
}

function ChartsIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M4 4v16h16" />
      <path d="M7 15l3.5 -4.5l3 3l4.5 -6" />
    </svg>
  );
}

function PricingIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M12 3v18" />
      <path d="M17 7c0-1.7-2.2-3-5-3s-5 1.3-5 3 2.2 3 5 3 5 1.3 5 3-2.2 3-5 3-5-1.3-5-3" />
    </svg>
  );
}

function ZoneModelIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <rect x="3.5" y="10.5" width="4" height="10" rx="1" />
      <rect x="10" y="6" width="4" height="14" rx="1" />
      <rect x="16.5" y="3" width="4" height="17" rx="1" />
    </svg>
  );
}

type NavItem = {
  href: string;
  label: string;
  icon: (props: { className?: string }) => JSX.Element;
  // Icon-tile colors (background + icon) for the inactive state. The active
  // item swaps to the solid brand tile instead - see NavLink.
  tile: string;
  // "account" items render below the divider, after the main list.
  section: "main" | "account";
  // Admin-gated items: shown only when AppSidebar's matching flag prop is on.
  gate?: "zoneModel" | "importSkippedLines";
  accent?: "red";
  // Live count of pooled Parlay Generator picks (Parlay's nav item only) -
  // set at render time in AppSidebar, not baked into the static list below,
  // since it comes from client state (ParlayPoolProvider).
  badgeCount?: number;
};

// The one ordered list for both the desktop rail and the mobile drawer.
// Dark-mode tile colors are the same hue at low opacity on the dark card.
const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardIcon, section: "main", tile: "bg-[#E7EFFF] text-[#1E5BD8] dark:bg-[#1E5BD8]/20 dark:text-[#7FA6F5]" },
  { href: "/cappers", label: "Cappers", icon: CappersIcon, section: "main", tile: "bg-[#FFF3DC] text-[#A15C00] dark:bg-[#A15C00]/25 dark:text-[#F2B25C]" },
  { href: "/picks", label: "Picks", icon: PicksIcon, section: "main", tile: "bg-[#E3F6EC] text-[#137A47] dark:bg-[#137A47]/25 dark:text-[#5FCB95]" },
  { href: "/charts", label: "Charts", icon: ChartsIcon, section: "main", tile: "bg-[#F0E9FF] text-[#6A3FD0] dark:bg-[#6A3FD0]/25 dark:text-[#B49BF0]" },
  { href: "/parlay", label: "Parlay Generator", icon: ParlayIcon, section: "main", tile: "bg-[#E7EFFF] text-[#1E5BD8] dark:bg-[#1E5BD8]/20 dark:text-[#7FA6F5]" },
  { href: "/live", label: "Live", icon: LiveIcon, section: "main", accent: "red", tile: "bg-[#FDECEC] text-[#DC2626] dark:bg-[#DC2626]/20 dark:text-[#F87171]" },
  { href: "/zone-model", label: "Zone Model", icon: ZoneModelIcon, section: "main", gate: "zoneModel", tile: "bg-[#DFF5F5] text-[#0E7272] dark:bg-[#0E7272]/30 dark:text-[#5CC9C9]" },
  { href: "/admin/import-skipped-lines", label: "Skipped Lines", icon: SkippedLinesIcon, section: "main", gate: "importSkippedLines", tile: "bg-[#FFEDE3] text-[#B4470F] dark:bg-[#B4470F]/25 dark:text-[#F29A6B]" },
  { href: "/pricing", label: "Plans & Billing", icon: PricingIcon, section: "account", tile: "bg-[#E4F4EA] text-[#18794E] dark:bg-[#18794E]/25 dark:text-[#62C998]" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, section: "account", tile: "bg-[#EEF0F4] text-[#4A5468] dark:bg-white/10 dark:text-[#A6AFC0]" },
];

function isActiveHref(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + "/");
}

function MenuIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

// Each item's icon sits in its own colored tile; the active item swaps that
// tile for a solid brand one and gets a tinted row. Live's label is red only
// while inactive; its red dot shows in both states.
function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  const isRed = item.accent === "red";
  const rowState = active
    ? "bg-[#EEF4FF] font-bold text-[#1747C9] dark:bg-brand-500/15 dark:text-brand-400"
    : "font-semibold text-[#4A5468] hover:bg-[#F6F8FB] hover:text-[#0B1633] dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground";
  const rowText = isRed && !active ? " !font-bold !text-[#C81E1E] dark:!text-red-400" : "";
  const tileState = active ? "bg-[#1E6BFF] text-white shadow-[0_3px_8px_rgba(30,107,255,.35)]" : item.tile;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={"flex h-[46px] shrink-0 items-center gap-3 rounded-xl px-2 text-[15px] transition " + rowState + rowText}
    >
      <span
        aria-hidden="true"
        className={"relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] transition " + tileState}
      >
        <Icon className="h-[18px] w-[18px]" />
        {isRed && (
          <span className="absolute -right-[3px] -top-[3px] h-[9px] w-[9px] rounded-full border-2 border-white bg-[#DC2626] animate-live-dot-ring motion-reduce:animate-none dark:border-card" />
        )}
      </span>
      <span className="flex-1">{item.label}</span>
      {Boolean(item.badgeCount) && (
        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-500 px-1.5 text-[11px] font-semibold text-white">
          {item.badgeCount}
        </span>
      )}
    </Link>
  );
}

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const render = (item: NavItem) => (
    <NavLink key={item.href} item={item} active={isActiveHref(pathname, item.href)} onNavigate={onNavigate} />
  );
  // The only part of the sidebar that scrolls (if the viewport is too short
  // for every item), so Drop Catalog and the account row below it stay put.
  return (
    <nav aria-label="Main" className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
      {items.filter((item) => item.section === "main").map(render)}
      <div className="mx-2 my-2.5 h-px shrink-0 bg-[#EDF0F5] dark:bg-border-subtle" />
      {items.filter((item) => item.section === "account").map(render)}
    </nav>
  );
}

// Full lockup (icon + divider + "Bettingview" wordmark) baked into the
// asset itself now, not just an icon paired with a separate text span - see
// the other two LogoMark copies (auth-card.tsx, marketing (marketing)/page.tsx)
// for the same change. Sized by height with w-auto so the asset's real
// (non-square) aspect ratio is preserved instead of being squashed into the
// old icon-only badge's fixed square box.
function LogoMark() {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- fixed local asset, not worth next/image's overhead at this size
    // The PNG is navy-on-transparent, designed for a light sidebar - flattened to
    // solid white for dark mode (brightness-0 then invert) rather than preserving
    // its two-tone navy/blue coloring, which a straight invert would shift toward
    // orange instead of keeping recognizably "blue".
    <img src="/logo-mark.png" alt="Bettingview" className="h-16 w-auto shrink-0 dark:brightness-0 dark:invert" />
  );
}

// Same look as the compact pill instances (Dashboard/Picks header, catalog
// page) via dropCatalogButtonBaseClass, just stretched full-width for the
// sidebar rail instead of hugging its own content.
function SidebarDropCatalog({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="mt-3 shrink-0 border-t border-[#EDF0F5] pt-3 dark:border-border-subtle">
      <a href="/picks/import" onClick={onNavigate} className={dropCatalogButtonBaseClass + " w-full"}>
        <LightningIcon />
        Drop Catalog
      </a>
    </div>
  );
}

function SignOutIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
      <path d="M15 16l4-4-4-4" />
      <path d="M19 12H9" />
    </svg>
  );
}

function AccountRow({ user }: { user: SidebarUser }) {
  const router = useRouter();
  const label = user.name ?? user.email;
  const initials = label.slice(0, 2).toUpperCase();

  async function handleSignOut() {
    clearParlaySlips();
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex shrink-0 items-center gap-2 px-2 pt-4">
      {user.profilePictureUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- external (Google) avatar, no next/image remote-pattern config in this project
        <img src={user.profilePictureUrl} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
      ) : (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500 text-[10px] font-medium text-white">
          {initials}
        </div>
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{label}</span>
      <button
        onClick={handleSignOut}
        aria-label="Sign out"
        className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <SignOutIcon />
      </button>
    </div>
  );
}

// Desktop keeps the always-visible left sidebar, now a floating rounded card
// inset from the page edge (see (app)/layout.tsx for the matching gap/padding
// on the main content card next to it). Below md:, that same content becomes
// a slide-in drawer opened from a compact top bar - full-bleed on mobile
// rather than another floating card, since there's no room to spare there.
export function AppSidebar({
  user,
  showZoneModel = false,
  showImportSkippedLines = false,
}: {
  user: SidebarUser;
  showZoneModel?: boolean;
  showImportSkippedLines?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { pool } = useParlayPool();
  // Zone Model is admin-only and server-gated (the page itself 404s
  // regardless of this) - this only decides whether the link appears, so a
  // non-admin never sees a nav entry for a route that would just 404 them.
  // Same for the import skipped-line report.
  const gates = { zoneModel: showZoneModel, importSkippedLines: showImportSkippedLines };
  const navItems = NAV_ITEMS.filter((item) => !item.gate || gates[item.gate]).map((item) =>
    item.href === "/parlay" ? { ...item, badgeCount: pool.length } : item
  );

  return (
    <>
      <div className="flex items-center justify-between border-b border-border-subtle bg-card p-3 md:hidden">
        <LogoMark />
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="rounded-lg p-2 text-muted-foreground hover:bg-muted"
        >
          <MenuIcon />
        </button>
      </div>

      <aside className="hidden min-h-0 w-72 flex-col rounded-2xl border border-[#E3E8EF] bg-card px-4 py-5 shadow-soft dark:border-border md:flex">
        <div className="mb-6 shrink-0 px-1">
          <LogoMark />
        </div>
        <NavLinks items={navItems} />
        <SidebarDropCatalog />
        <AccountRow user={user} />
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-card px-4 py-5 shadow-lg">
            <div className="mb-4 flex shrink-0 items-center justify-between">
              <LogoMark />
              <button
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="rounded-lg p-2 text-muted-foreground hover:bg-muted"
              >
                <CloseIcon />
              </button>
            </div>
            <NavLinks items={navItems} onNavigate={() => setOpen(false)} />
            <SidebarDropCatalog onNavigate={() => setOpen(false)} />
            <AccountRow user={user} />
          </aside>
        </div>
      )}
    </>
  );
}
