"use client";

import { useState } from "react";
import type { PickStatus } from "@prisma/client";
import { getCategoryRecordsAction } from "@/server/actions/picks";
import { getRecordColor, CATEGORY_RECENT_FORM_WINDOW, splitSegmentCategoryKey, type CategoryBreakdownItem, type PickCategoryKey } from "@/server/data/stats";
import { periodLabel } from "@/lib/bet-line";
import { Avatar, FavoriteStarIcon } from "@/components/dashboard/capper-panels";

export type ExpanderPick = {
  pickId: string;
  capperId: string;
  capperName: string;
  capperColorTag: string | null;
  capperIsFavorite: boolean;
  category: PickCategoryKey | null;
  betDetail: string;
  odds: number;
  units: number;
  status: PickStatus;
  // Which side of the matchup this pick is tied to, precomputed server-side
  // (see live/page.tsx) since classifying it needs the game's homeTeam/
  // awayTeam alongside betDetail. teamLabel is the short display name for
  // AWAY/HOME ("Pirates") - empty for OTHER, which always uses a fixed
  // "Totals & other markets" header instead.
  teamGroup: "AWAY" | "HOME" | "OTHER";
  teamLabel: string;
};

// Fixed AWAY -> HOME -> OTHER ordering (matches how the game card itself
// always lists away over home) - "OTHER" reuses the same three-group shape
// with a static label instead of a per-game team name.
const TEAM_GROUP_ORDER: ExpanderPick["teamGroup"][] = ["AWAY", "HOME", "OTHER"];
const OTHER_GROUP_LABEL = "Totals & other markets";

// This pick's own outcome, distinct from the capper's rolling category
// record shown below it - without this badge the two were easy to conflate,
// since a settled LOSS and a still-live PENDING pick otherwise rendered
// identically here.
const STATUS_LABELS: Record<PickStatus, string> = {
  PENDING: "Pending",
  WIN: "Win",
  LOSS: "Loss",
  PUSH: "Push",
  CANCELLED: "Cancelled",
};
const STATUS_CLASSES: Record<PickStatus, string> = {
  PENDING: "bg-muted text-muted-foreground",
  WIN: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
  LOSS: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400",
  PUSH: "bg-muted text-muted-foreground",
  CANCELLED: "bg-muted text-muted-foreground/70",
};

// Stricter than getRecordColor's plain 50% green/red split - this flags a
// capper as a genuine standout in this specific bet category, worth calling
// out with a highlighted row instead of just a colored badge.
const TOP_PERFORMER_THRESHOLD = 60;

// Fuller phrasing than the terse chip labels (PICK_CATEGORY_LABELS) used
// elsewhere - "on underdog moneyline picks" reads naturally in a sentence,
// where "Dog ML" doesn't. Segment categories (Q1 Over, 2H ML, ...) aren't
// listed - they're derived in categoryDescription below from periodLabel.
const CATEGORY_DESCRIPTIONS: Partial<Record<PickCategoryKey, string>> = {
  FAV_ML: "favorite moneyline",
  DOG_ML: "underdog moneyline",
  SPREAD_MINUS: "favorite spread",
  SPREAD_PLUS: "underdog spread",
  OVER: "over",
  UNDER: "under",
  F5_ML: "first-half moneyline",
  FIRST_HALF_ML: "first-half moneyline",
  FIRST_HALF_OVER: "first-half over",
  FIRST_HALF_UNDER: "first-half under",
  FIRST_HALF_SPREAD: "first-half spread",
  TD_PROP: "touchdown prop",
  NRFI: "NRFI",
  YRFI: "YRFI",
  F5_SPREAD_MINUS: "first-half favorite spread",
  F5_SPREAD_PLUS: "first-half underdog spread",
  F5_OVER: "first-half over",
  F5_UNDER: "first-half under",
  TEAM_TOTAL: "team total",
};

// "1st quarter over", "2nd half moneyline", "1st period under" for a segment
// category; the static phrasing above otherwise.
function categoryDescription(key: PickCategoryKey): string {
  const base = CATEGORY_DESCRIPTIONS[key];
  if (base) return base;
  const seg = splitSegmentCategoryKey(key);
  if (seg) {
    // side.toLowerCase() covers over / under / spread; ML is spelled out.
    const sideWord = seg.side === "ML" ? "moneyline" : seg.side.toLowerCase();
    return `${periodLabel(seg.period)} ${sideWord}`;
  }
  return "this category";
}

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

export function ChevronIcon({ up }: { up: boolean }) {
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

function recordLabel(record: { wins: number; losses: number; pushes: number }) {
  return record.wins + "-" + record.losses + (record.pushes > 0 ? "-" + record.pushes : "");
}

// One record + win% chip, green/red by its own win rate (independent of the
// other half when both all-time and last-20 are shown).
function ColoredRecord({ record }: { record: { wins: number; losses: number; pushes: number; winPct: number } }) {
  return (
    <span
      className={
        "font-medium " +
        (getRecordColor(record.winPct) === "green"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-red-600 dark:text-red-400")
      }
    >
      {recordLabel(record)} ({Math.round(record.winPct)}%)
    </span>
  );
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

  function renderPickCard(p: ExpanderPick) {
    const record = p.category ? records?.[p.capperId + "|" + p.category] : null;
    const isTopPerformer = Boolean(record && record.count > 0 && record.winPct >= TOP_PERFORMER_THRESHOLD);
    return (
      <div
        key={p.pickId}
        className={
          "rounded-[7px] border px-2.5 py-2 " +
          (isTopPerformer
            ? "border-emerald-300 bg-emerald-50/60 ring-1 ring-emerald-200 dark:border-emerald-700 dark:bg-emerald-500/10 dark:ring-emerald-800"
            : "border-border-subtle")
        }
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Avatar name={p.capperName} colorTag={p.capperColorTag} size={17} />
            <span className="truncate text-[12px] font-medium text-foreground">{p.capperName}</span>
            {p.capperIsFavorite && <FavoriteStarIcon />}
            {isTopPerformer && record && (
              <span className="shrink-0 rounded-full bg-emerald-100 px-1 py-0 text-[9px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                {Math.round(record.winPct)}%
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span
              className={
                "rounded-full px-1.5 py-0 text-[9px] font-semibold " + STATUS_CLASSES[p.status]
              }
            >
              {STATUS_LABELS[p.status]}
            </span>
            <span className="text-[12px] font-semibold text-foreground">
              {p.odds > 0 ? "+" : ""}
              {p.odds} <span className="font-normal text-muted-foreground">&middot; {p.units}u</span>
            </span>
          </div>
        </div>
        <div className="mt-0.5 pl-[23px] text-[11px] text-muted-foreground">
          {p.betDetail}
          {loading ? (
            <span className="text-[10px] text-muted-foreground"> &middot; Loading record...</span>
          ) : record && record.count > 0 && p.category ? (
            <span className="text-[10px]">
              {" "}
              &middot;{" "}
              {record.recent ? (
                <>
                  <ColoredRecord record={record} /> <span className="text-muted-foreground">all-time</span>
                  <span className="mx-1 text-muted-foreground/60">|</span>
                  <ColoredRecord record={record.recent} />{" "}
                  <span className="text-muted-foreground">last {CATEGORY_RECENT_FORM_WINDOW}</span>{" "}
                </>
              ) : (
                <>
                  <ColoredRecord record={record} />{" "}
                </>
              )}
              <span className="text-muted-foreground">on {categoryDescription(p.category)} picks</span>
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground"> &middot; No history in this category yet</span>
          )}
        </div>
      </div>
    );
  }

  const groups = TEAM_GROUP_ORDER.map((teamGroup) => {
    const groupPicks = picks.filter((p) => p.teamGroup === teamGroup);
    const label = teamGroup === "OTHER" ? OTHER_GROUP_LABEL : groupPicks[0]?.teamLabel;
    return { teamGroup, label, picks: groupPicks };
  }).filter((g) => g.picks.length > 0);

  return (
    <div onClick={(e) => e.preventDefault()}>
      <button
        onClick={toggle}
        className="mt-3 flex w-full items-center gap-2 rounded-lg bg-brand-50 px-3 py-2.5 text-sm font-medium text-brand-700 transition hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:hover:bg-brand-500/20"
      >
        <ListIcon />
        <span className="flex-1 text-left">
          {picks.length} pick{picks.length === 1 ? "" : "s"} on this game
        </span>
        <ChevronIcon up={open} />
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {groups.map((group) => (
            <div key={group.teamGroup}>
              <div className="mb-1.5 flex items-center gap-2 border-l-2 border-brand-300 pl-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label} &mdash; {group.picks.length} pick{group.picks.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="space-y-1.5">{group.picks.map((p) => renderPickCard(p))}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
