"use client";

import { useState } from "react";
import { getCategoryRecordsAction } from "@/server/actions/picks";
import { getRecordColor, type CategoryBreakdownItem, type PickCategoryKey } from "@/server/data/stats";
import { Avatar } from "@/components/dashboard/capper-panels";

export type ExpanderPick = {
  pickId: string;
  capperId: string;
  capperName: string;
  capperColorTag: string | null;
  category: PickCategoryKey | null;
  betDetail: string;
  odds: number;
  units: number;
};

// Stricter than getRecordColor's plain 50% green/red split - this flags a
// capper as a genuine standout in this specific bet category, worth calling
// out with a highlighted row instead of just a colored badge.
const TOP_PERFORMER_THRESHOLD = 60;

// Fuller phrasing than the terse chip labels (PICK_CATEGORY_LABELS) used
// elsewhere - "on underdog moneyline picks" reads naturally in a sentence,
// where "Dog ML" doesn't.
const CATEGORY_DESCRIPTIONS: Record<PickCategoryKey, string> = {
  FAV_ML: "favorite moneyline",
  DOG_ML: "underdog moneyline",
  SPREAD_MINUS: "favorite spread",
  SPREAD_PLUS: "underdog spread",
  OVER: "over",
  UNDER: "under",
  F5_ML: "first-half moneyline",
  NRFI: "NRFI",
};

const RECORD_BADGE_CLASSES: Record<ReturnType<typeof getRecordColor>, string> = {
  green: "bg-emerald-100 text-emerald-700",
  red: "bg-red-100 text-red-700",
};

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path d="M3.5 5.5l1.3 1.3l2.2 -2.3" />
      <path d="M3.5 12.5l1.3 1.3l2.2 -2.3" />
      <path d="M3.5 19.5l1.3 1.3l2.2 -2.3" />
      <path d="M11 6h9.5" />
      <path d="M11 13h9.5" />
      <path d="M11 20h9.5" />
    </svg>
  );
}

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"h-4 w-4 shrink-0 transition-transform " + (up ? "rotate-180" : "")}
      aria-hidden="true"
    >
      <path d="M6 9l6 6l6 -6" />
    </svg>
  );
}

function recordLabel(record: CategoryBreakdownItem) {
  return record.wins + "-" + record.losses + (record.pushes > 0 ? "-" + record.pushes : "");
}

export function GamePicksExpander({ picks }: { picks: ExpanderPick[] }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<Record<string, CategoryBreakdownItem | null> | null>(null);

  if (picks.length === 0) return null;

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const next = !open;
    setOpen(next);

    if (next && records === null) {
      setLoading(true);
      const pairs = picks
        .filter((p) => p.category !== null)
        .map((p) => ({ capperId: p.capperId, category: p.category as PickCategoryKey }));
      const result = await getCategoryRecordsAction(pairs);
      setRecords(result);
      setLoading(false);
    }
  }

  return (
    <div onClick={(e) => e.preventDefault()}>
      <button
        onClick={toggle}
        className="mt-3 flex w-full items-center gap-2 rounded-lg bg-brand-50 px-3 py-2.5 text-sm font-medium text-brand-700 transition hover:bg-brand-100"
      >
        <ListIcon />
        <span className="flex-1 text-left">
          {picks.length} pick{picks.length === 1 ? "" : "s"} on this game
        </span>
        <ChevronIcon up={open} />
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {picks.map((p) => {
            const record = p.category ? records?.[p.capperId + "|" + p.category] : null;
            const isTopPerformer = Boolean(record && record.count > 0 && record.winPct >= TOP_PERFORMER_THRESHOLD);
            return (
              <div
                key={p.pickId}
                className={
                  "rounded-lg border px-3 py-2.5 " +
                  (isTopPerformer ? "border-emerald-300 bg-emerald-50/60 ring-1 ring-emerald-200" : "border-gray-100")
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Avatar name={p.capperName} colorTag={p.capperColorTag} />
                    <span className="truncate text-sm font-medium text-gray-900">{p.capperName}</span>
                    {isTopPerformer && record && (
                      <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                        {Math.round(record.winPct)}%
                      </span>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-bold text-gray-900">
                      {p.odds > 0 ? "+" : ""}
                      {p.odds}
                    </div>
                    <div className="text-[11px] text-gray-400">{p.units}u</div>
                  </div>
                </div>
                <div className="mt-1.5">
                  <span className="inline-block rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                    {p.betDetail}
                  </span>
                </div>
                <div className="mt-1.5">
                  {loading ? (
                    <span className="text-xs text-gray-400">Loading record...</span>
                  ) : record && record.count > 0 && p.category ? (
                    <span className="flex items-center gap-1.5 text-xs">
                      <span
                        className={
                          "rounded-full px-2 py-0.5 font-medium " + RECORD_BADGE_CLASSES[getRecordColor(record.winPct)]
                        }
                      >
                        {recordLabel(record)} &middot; {Math.round(record.winPct)}%
                      </span>
                      <span className="text-gray-400">on {CATEGORY_DESCRIPTIONS[p.category]} picks</span>
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">No history in this category yet</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
