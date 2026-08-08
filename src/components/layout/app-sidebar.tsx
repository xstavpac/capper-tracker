"use client";

import { useState } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/cappers", label: "Cappers" },
  { href: "/picks", label: "Picks" },
  { href: "/reports", label: "Reports" },
  { href: "/settings", label: "Settings" },
];

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

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          onClick={onNavigate}
          className="rounded-lg px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 hover:text-gray-900"
        >
          {item.label}
        </Link>
      ))}
      <Link
        href="/live"
        onClick={onNavigate}
        className="rounded-lg px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
      >
        Live
      </Link>
    </>
  );
}

function AccountRow() {
  return (
    <div className="mt-auto flex items-center gap-2 px-2 pt-4">
      <UserButton afterSignOutUrl="/" />
      <span className="text-sm text-gray-500">Account</span>
    </div>
  );
}

// Desktop keeps the always-visible left sidebar. Below md:, that same
// content becomes a slide-in drawer opened from a compact top bar - the
// sidebar was previously a fixed 224px column with no mobile handling at
// all, which on a ~390px phone left almost no room for page content.
export function AppSidebar() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex items-center justify-between border-b border-gray-100 bg-white p-3 md:hidden">
        <span className="text-base font-semibold">Capper Tracker</span>
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-50"
        >
          <MenuIcon />
        </button>
      </div>

      <aside className="hidden w-56 flex-col gap-1 border-r border-gray-100 bg-white p-4 md:flex">
        <div className="mb-4 px-2 text-base font-semibold">Capper Tracker</div>
        <NavLinks />
        <AccountRow />
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col gap-1 bg-white p-4 shadow-lg">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-base font-semibold">Capper Tracker</span>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="rounded-lg p-2 text-gray-600 hover:bg-gray-50"
              >
                <CloseIcon />
              </button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
            <AccountRow />
          </aside>
        </div>
      )}
    </>
  );
}
