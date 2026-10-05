"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cappersHref, type CappersParams } from "@/lib/cappers-page-params";
import { SearchIcon } from "@/components/dashboard/cappers-icons";

// The search box. Like every /cappers control it only writes a URL param (`q`, debounced)
// and lets the server re-render; scroll:false keeps the viewport where it is. It is drawn twice,
// both on the same `q`: "header" in the dark banner from `sm` up, "leaderboard" (light, like the
// card's dropdowns) above the table on a phone.
export function CappersSearch({ params, variant = "header" }: { params: CappersParams; variant?: "header" | "leaderboard" }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState(params.q);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // Keep the box in step when the URL changes underneath it (back button, tab click).
  useEffect(() => setQuery(params.q), [params.q]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function onSearch(value: string) {
    setQuery(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (value.trim() !== params.q.trim()) startTransition(() => router.push(cappersHref(params, { q: value }), { scroll: false }));
    }, 300);
  }

  const header = variant === "header";
  return (
    <label
      className={
        header
          ? "hidden h-10 min-w-0 items-center gap-2 rounded-[10px] border border-[#263048] bg-[#1A2236] px-2.5 focus-within:border-brand-500 sm:flex sm:w-[168px] sm:flex-none min-[1700px]:w-[190px]"
          : "flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 shadow-sm focus-within:border-brand-400 sm:hidden"
      }
    >
      <SearchIcon className={"h-[15px] w-[15px] shrink-0 " + (header ? "text-[#A3ACC2]" : "text-muted-foreground")} />
      <input
        type="search"
        value={query}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search cappers"
        aria-label="Search cappers"
        className={
          "w-full min-w-0 border-none bg-transparent outline-none " +
          // 16px on the phone: iOS zooms the page when a smaller input takes focus.
          (header ? "text-[13px] text-white placeholder:text-[#A3ACC2]" : "text-base text-foreground placeholder:text-muted-foreground")
        }
      />
    </label>
  );
}
