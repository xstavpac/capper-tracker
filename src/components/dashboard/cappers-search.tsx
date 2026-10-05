"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cappersHref, type CappersParams } from "@/lib/cappers-page-params";
import { SearchIcon } from "@/components/dashboard/cappers-icons";

// The header's search box. Like every /cappers control it only writes a URL param (`q`, debounced)
// and lets the server re-render; scroll:false keeps the viewport where it is.
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
    <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-[#263048] bg-[#1A2236] px-3 focus-within:border-brand-500 sm:w-[170px] sm:flex-none min-[1700px]:w-[190px]">
      <SearchIcon className="h-[15px] w-[15px] shrink-0 text-[#A3ACC2]" />
      <input
        type="search"
        value={query}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search cappers..."
        aria-label="Search cappers"
        className="w-full min-w-0 border-none bg-transparent text-[13px] text-white outline-none placeholder:text-[#A3ACC2]"
      />
    </label>
  );
}
