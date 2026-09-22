"use client";

// One pick's card - capper, bet detail, status/odds, and its record-row
// block. Previously duplicated almost verbatim between game-picks-expander.tsx
// (Feed Live's expander) and team-picks-panel.tsx (Grid Live's fixed side
// panel), which independently rendered the exact same markup off the exact
// same ExpanderPick/CapperLeagueRecords shape. Pulled out here so both
// consumers - and the Parlay Pool's checkbox affordance below - share one
// implementation instead of a third copy.
import Link from "next/link";
import type { PickStatus } from "@prisma/client";
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
import { useParlayPool } from "@/components/parlay/parlay-pool-context";

const TOP_PERFORMER_THRESHOLD = 60;

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

function RecordRow({ pct, record, scope, winPct }: GameCardRecordRow) {
  const color =
    getRecordColor(winPct) === "green" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
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

// Parlay Pool's checkbox - rendered only while add mode is on. An
// already-pooled pick shows checked and disabled (removal happens from the
// Parlay tab's pool list, not by re-toggling it here), so a pick appearing
// on both Live and the Parlay tab's browse section can't be "added" twice or
// silently dropped by an accidental re-click.
function SelectCheckbox({ pick }: { pick: ExpanderPick }) {
  const { addMode, isInPool, checkedPicks, toggleChecked } = useParlayPool();
  if (!addMode) return null;
  const inPool = isInPool(pick.pickId);
  const checked = inPool || checkedPicks.has(pick.pickId);
  return (
    <label
      className="flex shrink-0 items-center"
      onClick={(e) => e.stopPropagation()}
      title={inPool ? "Already in your Parlay slip" : "Add to Parlay slip"}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={inPool}
        onChange={() => !inPool && toggleChecked(pick)}
        className="h-4 w-4 rounded border-border-subtle accent-brand-600 disabled:cursor-not-allowed"
        aria-label={inPool ? pick.capperName + " pick already in Parlay slip" : "Select " + pick.capperName + " pick"}
      />
    </label>
  );
}

export function PickCard({
  pick,
  records,
  loading,
  selectable = false,
  onRemove,
}: {
  pick: ExpanderPick;
  records: CapperLeagueRecords | null;
  loading: boolean;
  // Show the Parlay Pool checkbox - callers pass this only where add mode
  // can apply (Live's expander, the Parlay tab's browse section); the Parlay
  // tab's own pooled-picks list passes onRemove instead, never both.
  selectable?: boolean;
  onRemove?: () => void;
}) {
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
          {selectable && <SelectCheckbox pick={pick} />}
          <Avatar name={pick.capperName} colorTag={pick.capperColorTag} size={17} />
          <Link
            href={"/cappers/" + pick.capperId}
            onClick={(e) => e.stopPropagation()}
            className="truncate text-[12px] font-medium text-foreground hover:underline"
          >
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
          {onRemove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onRemove();
              }}
              aria-label={"Remove " + pick.capperName + " pick from Parlay slip"}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
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
