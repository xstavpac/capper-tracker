"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ADMIN_TABS, type AdminTabAlerts } from "@/lib/admin-tabs";

// The ops console's tab row. Client-side only for the active underline
// (usePathname); the tabs and their alert dots come from the server layout.
// Scrolls sideways inside itself on a narrow screen rather than widening the page.
export function AdminTabs({ alerts = {} }: { alerts?: AdminTabAlerts }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin sections" className="-mx-1 overflow-x-auto border-b border-border">
      <ul className="flex min-w-max gap-1 px-1">
        {ADMIN_TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(tab.href + "/");
          const alert = alerts[tab.key];
          return (
            <li key={tab.key}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`relative -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${
                  active
                    ? "border-brand-500 text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                }`}
              >
                {tab.label}
                {alert && (
                  <>
                    {/* The one-line reason shows on hover; the 16px box is the hover target around the 8px dot. */}
                    <span aria-hidden title={alert} className="inline-flex h-4 w-4 items-center justify-center">
                      <span className="h-2 w-2 rounded-full bg-[#DC2626] dark:bg-[#F87171]" />
                    </span>
                    <span className="sr-only">(needs attention: {alert})</span>
                  </>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
