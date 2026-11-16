"use client";

import { forwardRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Theme } from "@prisma/client";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { clearParlaySlips } from "@/components/parlay/parlay-pool-context";
import { useTheme } from "@/components/layout/theme-provider";
import {
  AdminIcon,
  ChevronDownIcon,
  LiveDot,
  MoonIcon,
  NAV_ITEMS,
  PricingIcon,
  SettingsIcon,
  SignOutIcon,
  SlipBadge,
  SunIcon,
  isActiveHref,
} from "@/components/layout/nav-items";

export type HeaderUser = { name: string | null; email: string; profilePictureUrl: string | null };

// Every row is at least 44px tall (touch target).
const ROW = "flex min-h-[44px] w-full items-center gap-3 rounded-[10px] px-3 text-left text-[15px] font-semibold transition ";
const ROW_IDLE = "text-[#2A3550] hover:bg-[#F3F6FB] dark:text-card-foreground dark:hover:bg-muted ";
const ROW_ACTIVE = "bg-[#EEF4FF] text-[#1747C9] dark:bg-brand-500/15 dark:text-brand-400 ";
const ICON = "h-[18px] w-[18px] shrink-0";
const DIVIDER = <div className="mx-2 my-1.5 h-px bg-[#EDF0F5] dark:bg-border" />;

function AccountHeader({ user }: { user: HeaderUser }) {
  const label = user.name ?? user.email;
  const initials = label.slice(0, 2).toUpperCase();
  return (
    <div className="flex min-h-[44px] items-center gap-3 px-3 py-2">
      {user.profilePictureUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- external (Google) avatar, no next/image remote-pattern config in this project
        <img src={user.profilePictureUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
      ) : (
        <div aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white">
          {initials}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-bold text-[#0B1633] dark:text-card-foreground">{label}</div>
        {user.name && <div className="truncate text-[13px] text-muted-foreground">{user.email}</div>}
      </div>
    </div>
  );
}

// Light/Dark, through the same ThemeProvider context the Settings page's
// ThemeToggle uses (setTheme -> updateThemePreferenceAction).
function AppearanceSwitch() {
  const { theme, setTheme, isSaving } = useTheme();
  const options = [
    { value: Theme.LIGHT, label: "Light", icon: SunIcon },
    { value: Theme.DARK, label: "Dark", icon: MoonIcon },
  ];
  return (
    <div className="px-3 pb-2 pt-1">
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[1.5px] text-muted-foreground">Appearance</div>
      <div role="group" aria-label="Appearance" className="flex gap-1 rounded-[10px] bg-[#F1F4F9] p-1 dark:bg-muted">
        {options.map(({ value, label, icon: Icon }) => {
          const active = theme === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              disabled={isSaving}
              onClick={() => !active && setTheme(value)}
              className={
                "flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg text-sm font-semibold transition disabled:opacity-60 " +
                (active
                  ? "bg-white text-[#0B1633] shadow-soft dark:bg-card dark:text-card-foreground"
                  : "text-muted-foreground hover:text-[#0B1633] dark:hover:text-card-foreground")
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type HeaderMenuProps = {
  id: string;
  user: HeaderUser;
  showAdminOps: boolean;
  slipSize: number;
  onNavigate: () => void;
};

// The hamburger's dropdown. Opening, closing (outside click, Esc, route
// change) and placement are SiteHeader's; this is the card's content.
export const HeaderMenu = forwardRef<HTMLDivElement, HeaderMenuProps>(function HeaderMenu(
  { id, user, showAdminOps, slipSize, onNavigate },
  ref
) {
  const pathname = usePathname();
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Same sequence the sidebar's sign-out ran.
  async function handleSignOut() {
    clearParlaySlips();
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  const linkRow = (href: string) => ROW + (isActiveHref(pathname, href) ? ROW_ACTIVE : ROW_IDLE);

  return (
    <div
      ref={ref}
      id={id}
      className="absolute right-4 top-full z-50 mt-2 max-h-[calc(100dvh-140px)] w-[300px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-[#E3E8F0] bg-white p-2 shadow-[0_18px_40px_rgba(5,11,28,.28)] dark:border-border dark:bg-card sm:right-6"
    >
      {/* Below 1024px the header's tabs are hidden; the same list leads the menu. */}
      <nav aria-label="Main" className="lg:hidden">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isActiveHref(pathname, item.href);
          return (
            <Link key={item.href} href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={linkRow(item.href)}>
              <span className="relative flex">
                <Icon className={ICON} />
                {item.liveDot && <LiveDot ringClassName="border-white dark:border-card" />}
              </span>
              <span className="flex-1">{item.label}</span>
              {item.slipBadge && <SlipBadge count={slipSize} tone="card" />}
            </Link>
          );
        })}
        {DIVIDER}
      </nav>

      <AccountHeader user={user} />
      {DIVIDER}

      <button type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((v) => !v)} className={ROW + ROW_IDLE}>
        <SettingsIcon className={ICON} />
        <span className="flex-1">Settings</span>
        <ChevronDownIcon className={"h-4 w-4 shrink-0 text-muted-foreground transition-transform " + (settingsOpen ? "rotate-180" : "")} />
      </button>
      {settingsOpen && (
        <div className="pb-1">
          <AppearanceSwitch />
          <Link href="/settings" onClick={onNavigate} className="flex min-h-[44px] items-center px-3 text-sm font-semibold text-[#1E5BD8] hover:underline dark:text-brand-400">
            All settings →
          </Link>
        </div>
      )}

      <Link href="/pricing" onClick={onNavigate} className={linkRow("/pricing")}>
        <PricingIcon className={ICON} />
        <span className="flex-1">Plans &amp; Billing</span>
      </Link>

      {showAdminOps && (
        <Link href="/admin" onClick={onNavigate} className={linkRow("/admin")}>
          <AdminIcon className={ICON} />
          <span className="flex-1">Admin</span>
        </Link>
      )}

      {DIVIDER}

      <button type="button" onClick={handleSignOut} className={ROW + "text-[#DC2626] hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"}>
        <SignOutIcon className={ICON} />
        <span className="flex-1">Log out</span>
      </button>
    </div>
  );
});
