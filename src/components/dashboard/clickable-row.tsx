"use client";

import { useRouter } from "next/navigation";

// A table row that navigates on click. Clicks that land on a link or button inside
// the row (the name link, the favorite star, the chevron) keep their own behaviour.
export function ClickableRow({ href, children }: { href: string; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <tr
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        router.push(href);
      }}
      className="cursor-pointer border-b border-border-subtle last:border-0 hover:bg-muted"
    >
      {children}
    </tr>
  );
}
