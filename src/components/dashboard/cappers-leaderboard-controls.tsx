"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  RANGE_OPTIONS,
  MIN_PICKS_OPTIONS,
  SORT_OPTIONS,
  cappersHref,
  type CappersParams,
  type CappersSortKey,
} from "@/lib/cappers-page-params";

const selectClass =
  "rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-brand-400 focus:outline-none";

// Every control writes a URL param and lets the server re-render; nothing here holds
// data. scroll:false keeps the viewport where it is, like the time tabs.
export function CappersLeaderboardControls({ params, leagues }: { params: CappersParams; leagues: string[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState(params.q);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const go = (overrides: Partial<CappersParams>) =>
    startTransition(() => router.push(cappersHref(params, overrides), { scroll: false }));

  // Keep the box in step when the URL changes underneath it (back button, tab click).
  useEffect(() => setQuery(params.q), [params.q]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function onSearch(value: string) {
    setQuery(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (value.trim() !== params.q.trim()) go({ q: value });
    }, 300);
  }

  return (
    <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
      <input
        type="search"
        value={query}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search cappers..."
        aria-label="Search cappers"
        className={selectClass + " col-span-2 placeholder:text-muted-foreground lg:col-span-1"}
      />
      <select aria-label="League" value={params.league ?? ""} onChange={(e) => go({ league: e.target.value || undefined })} className={selectClass}>
        <option value="">All leagues</option>
        {leagues.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      <select aria-label="Time range" value={params.range} onChange={(e) => go({ range: e.target.value, window: RANGE_OPTIONS.find((r) => r.key === e.target.value)!.window })} className={selectClass}>
        {RANGE_OPTIONS.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
      <select aria-label="Minimum picks" value={params.min} onChange={(e) => go({ min: Number(e.target.value) })} className={selectClass}>
        {MIN_PICKS_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n === 0 ? "Any picks" : n + "+ picks"}
          </option>
        ))}
      </select>
      <select aria-label="Sort by" value={params.sort} onChange={(e) => go({ sort: e.target.value as CappersSortKey })} className={selectClass}>
        {SORT_OPTIONS.map((s) => (
          <option key={s.key} value={s.key}>
            {"Sort: " + s.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function FavoritesToggle({ params }: { params: CappersParams }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={params.fav}
      onClick={() => startTransition(() => router.push(cappersHref(params, { fav: !params.fav }), { scroll: false }))}
      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-amber-400" fill="currentColor" aria-hidden="true">
        <path d="M12 2.5l2.9 6.3 6.9.7-5.2 4.7 1.6 6.8L12 17.6l-6.2 3.4 1.6-6.8-5.2-4.7 6.9-.7z" />
      </svg>
      Show favorites only
      <span className={"relative inline-block h-5 w-9 rounded-full transition " + (params.fav ? "bg-brand-600" : "bg-muted")}>
        <span className={"absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all " + (params.fav ? "left-[18px]" : "left-0.5")} />
      </span>
    </button>
  );
}
