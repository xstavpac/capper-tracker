"use client";

import { useState } from "react";
import type { PickStatus } from "@prisma/client";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import { getRecordColor, LEAGUE_RECORD_LAST_N, type LeagueRecordCard, type PickCategoryKey } from "@/server/data/stats";
import { gameCardRecordSegments } from "@/lib/game-card-record-line";
import { Avatar, FavoriteStarIcon } from "@/components/dashboard/capper-panels";

export type ExpanderPick = {
  pickId: string;
  capperId: string;
  capperName: string;
  capperColorTag: string | null;
  capperIsFavorite: boolean;
  category: PickCategoryKey | null;
  // The game's league (sport name, e.g. "NCAAF") - the emphasized middle
  // column of the condensed record line. One per /live page tab.
  leagueName: string;
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

// One segment of the condensed record line ("All 12-3 80%", "NCAAF 8-2 80%",
// "L20 4-1 80%"). Every segment's record + % is green/red by its OWN win
// rate; the current-league segment additionally gets bold weight (label and
// numbers) since it's the number the viewer is deciding on. Character content
// matches gameCardRecordLineText (game-card-record-line.ts), which the width
// guard tests against.
function RecordSegment({
  label,
  record,
  pct,
  winPct,
  emphasized,
}: {
  label: string;
  record: string;
  pct: string;
  winPct: number;
  emphasized: boolean;
}) {
  const color =
    getRecordColor(winPct) === "green"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-red-600 dark:text-red-400";
  return (
    <span className="whitespace-nowrap">
      <span className={emphasized ? "font-semibold text-muted-foreground" : "text-muted-foreground"}>{label}</span>{" "}
      <span className={color + (emphasized ? " font-bold" : " font-medium")}>
        {record} {pct}
      </span>
    </span>
  );
}

export function GamePicksExpander({ picks }: { picks: ExpanderPick[] }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<Record<string, LeagueRecordCard | null> | null>(null);

  if (picks.length === 0) return null;

  // capperId | leagueSport | category - matches leagueRecordKey (picks.ts).
  const recordKey = (p: ExpanderPick) => p.capperId + "|" + p.leagueName + "|" + p.category;

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const next = !open;
    setOpen(next);

    if (next && records === null) {
      setLoading(true);
      const pairs = picks
        .filter((p) => p.category !== null)
        .map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category as PickCategoryKey }));
      const result = await getLeagueRecordsAction(pairs);
      setRecords(result);
      setLoading(false);
    }
  }

  function renderPickCard(p: ExpanderPick) {
    const card = p.category ? records?.[recordKey(p)] : null;
    const hasHistory = Boolean(card && card.overall.count > 0);
    // "Top performer" highlight keys off the current-league record (the
    // emphasized number) - "good at this bet type in THIS league", not blended.
    const isTopPerformer = Boolean(card && card.league.count > 0 && card.league.winPct >= TOP_PERFORMER_THRESHOLD);
    const segments =
      card && hasHistory ? gameCardRecordSegments(card, p.leagueName, LEAGUE_RECORD_LAST_N) : [];
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
            {isTopPerformer && card && (
              <span className="shrink-0 rounded-full bg-emerald-100 px-1 py-0 text-[9px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                {Math.round(card.league.winPct)}%
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
          <span className="text-foreground/90">{p.betDetail}</span>
          {loading ? (
            <span className="text-[10px] text-muted-foreground"> &middot; Loading record...</span>
          ) : segments.length > 0 ? (
            <span className="text-[10px]">
              {segments.map((s, i) => (
                <span key={s.label} className="text-muted-foreground/60">
                  {i === 0 ? " · " : " | "}
                  <RecordSegment {...s} />
                </span>
              ))}
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
