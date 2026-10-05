"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cappersHref, type CappersParams } from "@/lib/cappers-page-params";
import { SearchIcon } from "@/components/dashboard/cappers-icons";

// The search box. Like every /cappers control it only writes a URL param (`q`, debounced)
// and lets the server re-render; scroll:false keeps the viewport where it is. It sits above the
// leaderboard table, styled like the card's dropdowns.
export function CappersSearch({ params }: { params: CappersParams }) {
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

  return (
    <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 shadow-sm focus-within:border-brand-400 sm:h-10 sm:max-w-[320px]">
      <SearchIcon className="h-[15px] w-[15px] shrink-0 text-muted-foreground" />
      <input
        type="search"
        value={query}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search cappers"
        aria-label="Search cappers"
        // 16px on the phone: iOS zooms the page when a smaller input takes focus.
        className="w-full min-w-0 border-none bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm"
      />
    </label>
  );
}
