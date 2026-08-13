"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { dropCatalogButtonBaseClass, LightningIcon } from "@/components/dashboard/drop-catalog-button";

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

function CappersIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 20v-1a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v1" />
      <path d="M16 4.2a3 3 0 0 1 0 5.6" />
      <path d="M21 20v-1a4 4 0 0 0 -3 -3.85" />
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

function ReportsIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <rect x="7.5" y="12" width="3" height="6" rx="0.5" />
      <rect x="12.5" y="8" width="3" height="10" rx="0.5" />
      <rect x="17.5" y="5" width="3" height="13" rx="0.5" />
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

function SharpMoneyIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
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

type NavItem = {
  href: string;
  label: string;
  icon: (props: { className?: string }) => JSX.Element;
  accent?: "red";
};

const BASE_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
  { href: "/cappers", label: "Cappers", icon: CappersIcon },
  { href: "/picks", label: "Picks", icon: PicksIcon },
  { href: "/reports", label: "Reports", icon: ReportsIcon },
  { href: "/charts", label: "Charts", icon: ChartsIcon },
  { href: "/pricing", label: "Plans & Billing", icon: PricingIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
  { href: "/live", label: "Live", icon: LiveIcon, accent: "red" },
  { href: "/sharp-money", label: "Sharp Money", icon: SharpMoneyIcon },
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

// Active item gets the accent (brand, or red for Live) as both background and
// text/icon color - everything else stays neutral gray until hovered.
function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  const isRed = item.accent === "red";
  const activeClass = isRed ? "bg-red-50 text-red-600" : "bg-brand-50 text-brand-700";
  const inactiveClass = isRed ? "text-red-600 hover:bg-red-50" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900";

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={
        "flex items-center gap-2.5 rounded-[9px] px-3 py-[9px] text-[15px] font-medium transition " +
        (active ? activeClass : inactiveClass)
      }
    >
      <Icon className="h-5 w-5 shrink-0" />
      {item.label}
    </Link>
  );
}

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <>
      {items.map((item) => (
        <NavLink key={item.href} item={item} active={isActiveHref(pathname, item.href)} onNavigate={onNavigate} />
      ))}
    </>
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
    <img src="/logo-mark.png" alt="Bettingview" className="h-16 w-auto shrink-0" />
  );
}

// Same look as the compact pill instances (Dashboard/Picks header, catalog
// page) via dropCatalogButtonBaseClass, just stretched full-width for the
// sidebar rail instead of hugging its own content.
function SidebarDropCatalog({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <div className="my-3 border-t border-gray-100" />
      <a href="/picks/import" onClick={onNavigate} className={dropCatalogButtonBaseClass + " w-full"}>
        <LightningIcon />
        Drop Catalog
      </a>
    </>
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
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <div className="mt-auto flex items-center gap-2 px-2 pt-4">
      {user.profilePictureUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- external (Google) avatar, no next/image remote-pattern config in this project
        <img src={user.profilePictureUrl} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
      ) : (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500 text-[10px] font-medium text-white">
          {initials}
        </div>
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-gray-700">{label}</span>
      <button
        onClick={handleSignOut}
        aria-label="Sign out"
        className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-50 hover:text-gray-600"
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
export function AppSidebar({ user }: { user: SidebarUser }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex items-center justify-between border-b border-gray-100 bg-white p-3 md:hidden">
        <LogoMark />
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-50"
        >
          <MenuIcon />
        </button>
      </div>

      <aside className="hidden w-72 flex-col gap-1 rounded-xl border border-gray-200 bg-white px-4 py-5 shadow-soft md:flex">
        <div className="mb-6 px-1">
          <LogoMark />
        </div>
        <NavLinks items={BASE_NAV_ITEMS} />
        <SidebarDropCatalog />
        <AccountRow user={user} />
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col gap-1 bg-white px-4 py-5 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <LogoMark />
              <button
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="rounded-lg p-2 text-gray-600 hover:bg-gray-50"
              >
                <CloseIcon />
              </button>
            </div>
            <NavLinks items={BASE_NAV_ITEMS} onNavigate={() => setOpen(false)} />
            <SidebarDropCatalog onNavigate={() => setOpen(false)} />
            <AccountRow user={user} />
          </aside>
        </div>
      )}
    </>
  );
}
