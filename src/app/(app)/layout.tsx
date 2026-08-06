import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/cappers", label: "Cappers" },
  { href: "/picks", label: "Picks" },
  { href: "/reports", label: "Reports" },
  { href: "/settings", label: "Settings" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col gap-1 border-r border-gray-100 bg-white p-4">
        <div className="mb-4 px-2 text-base font-semibold">Capper Tracker</div>
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-lg px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 hover:text-gray-900"
          >
            {item.label}
          </Link>
        ))}
        <Link
          href="/live"
          className="rounded-lg px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
        >
          Live
        </Link>
        <div className="mt-auto flex items-center gap-2 px-2 pt-4">
          <UserButton afterSignOutUrl="/" />
          <span className="text-sm text-gray-500">Account</span>
        </div>
      </aside>
      <main className="flex-1 bg-gray-50 p-8">{children}</main>
    </div>
  );
}
