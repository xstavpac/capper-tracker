"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import { getRecordColor, PICK_CATEGORY_MARKET_NOUN } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";
import {
  gameCardRecordRows,
  gameCardStreakGlyph,
  gameCardStreakTooltip,
  GAME_CARD_NO_HISTORY_TEXT,
  GAME_CARD_STREAK_GLYPH_CLASS,
  type GameCardRecordRow,
  type GameCardStreak,
} from "@/lib/game-card-record-line";
import { Avatar, FavoriteStarIcon } from "@/components/dashboard/capper-panels";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { AdvancedLiveGamePanelData, AdvancedLiveTeamSideData } from "@/components/live/advanced-live-team-panel-data";

// Advanced Live's fixed detail panel - shows BOTH teams' picks at once,
// stacked in one card, unlike GamePicksExpander (which lists AWAY/HOME/OTHER
// all at once when opened, but only for one game card at a time inline in
// the board). Deliberately not built on top of GamePicksExpander: that
// component's whole shape is "expand to reveal every group", the opposite of
// what a fixed side panel needs. This reuses the same underlying pieces
// GamePicksExpander uses for the pick-card itself (record-fetching action,
// record-row/streak formatting, Avatar) rather than re-deriving any of that -
// it's a new, purpose-built component around old, unchanged data logic, not
// a parallel calculation.
//
// A capper's category record is fetched here (not upstream) for the same
// reason GamePicksExpander defers it to expand-time: it requires each
// capper's full pick history and would be wasteful to compute for every game
// on the board just because Advanced Live is open. Each team section fetches
// its own records independently, re-fetched whenever that team's pick set
// changes (a game switch) - see the useEffect key below.

const TOP_PERFORMER_THRESHOLD = 60;

const STATUS_LABELS: Record<ExpanderPick["status"], string> = {
  PENDING: "Pending",
  WIN: "Win",
  LOSS: "Loss",
  PUSH: "Push",
  CANCELLED: "Cancelled",
};
const STATUS_CLASSES: Record<ExpanderPick["status"], string> = {
  PENDING: "bg-muted text-muted-foreground",
  WIN: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
  LOSS: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400",
  PUSH: "bg-muted text-muted-foreground",
  CANCELLED: "bg-muted text-muted-foreground/70",
};

function RecordRow({ pct, record, scope, winPct }: GameCardRecordRow) {
  const color =
    getRecordColor(winPct) === "green"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-red-600 dark:text-red-400";
  return (
    <div>
      <span className={color + " font-semibold"}>
        {pct} ({record})
      </span>{" "}
      <span className="text-muted-foreground">{scope}</span>
    </div>
  );
}

function StreakRow({ streak }: { streak: GameCardStreak | null | undefined }) {
  const glyph = gameCardStreakGlyph(streak);
  if (!glyph) return null;
  const isWin = streak!.type === "WIN";
  const color = isWin ? "text-orange-600 dark:text-orange-400" : "text-sky-600 dark:text-sky-400";
  return (
    <div className={"font-semibold " + color} title={gameCardStreakTooltip(streak)}>
      <span className={GAME_CARD_STREAK_GLYPH_CLASS}>{glyph}</span> {streak!.count} game {isWin ? "win" : "losing"}{" "}
      streak
    </div>
  );
}

function PickCard({ pick, records, loading }: { pick: ExpanderPick; records: CapperLeagueRecords | null; loading: boolean }) {
  const recordKey = pick.capperId + "|" + pick.leagueName + "|" + pick.category;
  const card = (pick.category ? records?.records[recordKey] : null) ?? null;
  const streak = records?.streaks[pick.capperId] ?? null;
  const last20 = records?.last20[pick.capperId] ?? null;
  const hasHistory = Boolean(card && card.overall.count > 0);
  const isTopPerformer = Boolean(card && card.league.count > 0 && card.league.winPct >= TOP_PERFORMER_THRESHOLD);
  const rows = records
    ? gameCardRecordRows(hasHistory && pick.category ? card : null, {
        leagueName: pick.leagueName,
        marketNoun: pick.category ? PICK_CATEGORY_MARKET_NOUN[pick.category] : "",
        hasLeagueHistory: Boolean(card && card.league.count > 0),
        last20,
      })
    : [];

  return (
    <div
      className={
        "rounded-[7px] border px-2.5 py-2 " +
        (isTopPerformer
          ? "border-emerald-300 bg-emerald-50/60 ring-1 ring-emerald-200 dark:border-emerald-700 dark:bg-emerald-500/10 dark:ring-emerald-800"
          : "border-border-subtle")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Avatar name={pick.capperName} colorTag={pick.capperColorTag} size={17} />
          <Link href={"/cappers/" + pick.capperId} className="truncate text-[12px] font-medium text-foreground hover:underline">
            {pick.capperName}
          </Link>
          {pick.capperIsFavorite && <FavoriteStarIcon />}
          {isTopPerformer && card && (
            <span className="shrink-0 rounded-full bg-emerald-100 px-1 py-0 text-[9px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
              {Math.round(card.league.winPct)}%
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={"rounded-full px-1.5 py-0 text-[9px] font-semibold " + STATUS_CLASSES[pick.status]}>
            {STATUS_LABELS[pick.status]}
          </span>
          <span className="text-[12px] font-semibold text-foreground">
            {pick.odds > 0 ? "+" : ""}
            {pick.odds} <span className="font-normal text-muted-foreground">&middot; {pick.units}u</span>
          </span>
        </div>
      </div>
      <div className="mt-0.5 pl-[23px] text-[11px] text-muted-foreground">
        <div className="text-foreground/90">{pick.betDetail}</div>
        {loading ? (
          <div className="mt-0.5 text-[10px] text-muted-foreground">Loading record&hellip;</div>
        ) : (
          <div className="mt-0.5 space-y-0.5 text-[10px] leading-snug">
            {!hasHistory && <div className="text-muted-foreground">{GAME_CARD_NO_HISTORY_TEXT}</div>}
            {rows.map((r) => (
              <RecordRow key={r.kind} {...r} />
            ))}
            <StreakRow streak={streak} />
          </div>
        )}
      </div>
    </div>
  );
}

// One team's section within the combined panel: header (color dot, name,
// pick count) plus its pick list or empty-state. Fetches its own capper
// records independently of the other team's section so one team's picks
// rendering isn't blocked on the other team's record fetch.
function TeamPickSection({ teamLabel, teamColor, picks }: AdvancedLiveTeamSideData) {
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<CapperLeagueRecords | null>(null);

  const picksKey = picks.map((p) => p.pickId).join(",");

  useEffect(() => {
    let cancelled = false;
    if (picks.length === 0) {
      setRecords(null);
      return;
    }
    setLoading(true);
    setRecords(null);
    const entries = picks.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }));
    getLeagueRecordsAction(entries).then((result) => {
      if (cancelled) return;
      setRecords(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- picksKey stands in for picks (array identity changes every render otherwise)
  }, [picksKey]);

  return (
    <div>
      <div
        className="mb-2 flex items-center gap-1.5 rounded-md px-2 py-1"
        style={{
          // Same wash formula as GamePicksExpander's team-group header
          // (hex color + a ~12% alpha suffix) - reused as-is so the two
          // views' team-hue treatment matches exactly.
          backgroundColor: teamColor ? teamColor + "1F" : "rgb(var(--muted-foreground) / 0.10)",
        }}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15"
          style={{ backgroundColor: teamColor ?? "rgb(var(--muted-foreground))" }}
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-foreground">{teamLabel}</span>
        <span className="text-xs text-muted-foreground">
          &mdash; {picks.length} pick{picks.length === 1 ? "" : "s"}
        </span>
      </div>

      {picks.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No logged picks for {teamLabel}.</p>
      ) : (
        <div className="space-y-1.5">
          {picks.map((pick) => (
            <PickCard key={pick.pickId} pick={pick} records={records} loading={loading} />
          ))}
        </div>
      )}
    </div>
  );
}

export function GameDetailPanel({ data }: { data: AdvancedLiveGamePanelData }) {
  return (
    <div className="rounded-card bg-card p-4 shadow-soft">
      <TeamPickSection {...data.away} />
      <div className="my-4 border-t border-border-subtle" />
      <TeamPickSection {...data.home} />
    </div>
  );
}
