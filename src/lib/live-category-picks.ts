// The /live category panel's "current-slate picks" list: which picks a tile
// counts, and the order its expanded list shows them in.
//
// The unit is the PICK. One capper can appear several times, and the same pick
// from several cappers is several rows - nothing is collapsed.
//
// This is a SORT ORDER, not a grade. The Wilson value below never leaves this
// module's comparator; a row shows only the record it was ranked on.
//
// Pure and client-safe (type-only imports from server modules).
import type { PickStatus } from "@prisma/client";
import type { ScoreGame } from "@/server/data/odds";
import type { PickCategoryKey, LeagueRecordCard } from "@/server/data/stats";
import { orderBoardGames, matchScoreToGame } from "@/components/live/live-scoreboard-ordering";
import { wilsonLowerBound } from "@/lib/wilson-lower-bound";

// A capper's league+category record drives a pick's rank only once it has this
// many decided picks (wins + losses + pushes); below it the all-time category
// record does. Specific to this panel - deliberately not RANKING_MIN_SAMPLE (5):
// at 5 a 4-2 league record displaced a 27-17 all-time one.
export const LIVE_LEAGUE_SPLIT_MIN_SAMPLE = 10;

export const LIVE_CATEGORY_REVEAL_STEP = 5;

// The slim per-pick slice the panel needs - not the board's full ExpanderPick.
export type LiveCategoryPick = {
  pickId: string;
  // Index into the board's game list (the same index matchedPicksByGame uses).
  gameIndex: number;
  category: PickCategoryKey | null;
  betDetail: string;
  odds: number;
  capperId: string;
  capperName: string;
  status: PickStatus;
  gameTime: string;
};

export type LiveCategoryGame = { homeTeam: string; awayTeam: string; commenceTime: string };

// The games the board is showing right now: the same orderBoardGames call, on
// the same scores, the Feed and Grid boards make - so a tile's count can never
// disagree with the cards.
export function visibleGameIndexes(games: LiveCategoryGame[], scores: ScoreGame[], todayKey: string): Set<number> {
  const withScores = games.map((game, gameIndex) => ({ game, gameIndex, score: matchScoreToGame(scores, game) }));
  return new Set(orderBoardGames(withScores, todayKey).map((g) => g.gameIndex));
}

// A tile's pool: every pick on a visible card except CANCELLED ones, grouped by
// category. Picks with no category are on no tile.
export function slatePicksByCategory(
  picks: LiveCategoryPick[],
  visible: Set<number>
): Map<PickCategoryKey, LiveCategoryPick[]> {
  const out = new Map<PickCategoryKey, LiveCategoryPick[]>();
  for (const p of picks) {
    if (p.category === null || p.status === "CANCELLED" || !visible.has(p.gameIndex)) continue;
    const list = out.get(p.category);
    if (list) list.push(p);
    else out.set(p.category, [p]);
  }
  return out;
}

export type DrivingRecord = { wins: number; losses: number; pushes: number; source: "LEAGUE" | "ALL_TIME" };

// The record a pick is ranked on, and the one its row shows.
export function drivingRecord(card: LeagueRecordCard | null | undefined): DrivingRecord | null {
  if (!card) return null;
  if (card.league.count >= LIVE_LEAGUE_SPLIT_MIN_SAMPLE) {
    return { wins: card.league.wins, losses: card.league.losses, pushes: card.league.pushes, source: "LEAGUE" };
  }
  if (card.overall.count > 0) {
    return { wins: card.overall.wins, losses: card.overall.losses, pushes: card.overall.pushes, source: "ALL_TIME" };
  }
  return null;
}

export type RankedLivePick = { pick: LiveCategoryPick; record: DrivingRecord | null };

// `records` is getCapperLeagueRecords' `records` map, keyed the way
// leagueRecordKey (server/data/picks.ts) builds it; restated here because that
// module is server-only.
//
// Order: Wilson lower bound of the driving record, then more decided picks,
// then the earlier game, then pick id. Picks with no record go last, in the
// same game-time / id order.
export function rankCategoryPicks(
  picks: LiveCategoryPick[],
  leagueName: string,
  records: Record<string, LeagueRecordCard | null>
): RankedLivePick[] {
  const rows = picks.map((pick) => {
    const record = drivingRecord(records[pick.capperId + "|" + leagueName + "|" + pick.category]);
    return {
      pick,
      record,
      wilson: record ? wilsonLowerBound(record.wins, record.losses) : 0,
      decided: record ? record.wins + record.losses : 0,
      time: new Date(pick.gameTime).getTime(),
    };
  });
  rows.sort((a, b) => {
    if (!a.record !== !b.record) return a.record ? -1 : 1;
    if (b.wilson !== a.wilson) return b.wilson - a.wilson;
    if (b.decided !== a.decided) return b.decided - a.decided;
    if (a.time !== b.time) return a.time - b.time;
    return a.pick.pickId < b.pick.pickId ? -1 : a.pick.pickId > b.pick.pickId ? 1 : 0;
  });
  return rows.map(({ pick, record }) => ({ pick, record }));
}

export const NO_RECORD_TEXT = "No record";

// "14–9 MLB Fav ML" when the league record drove the rank, "31–14 Fav ML" when
// the all-time one did. W–L–P when there are pushes, like the cards.
export function drivingRecordText(record: DrivingRecord | null, leagueName: string, categoryLabel: string): string {
  if (!record) return NO_RECORD_TEXT;
  const wl = record.wins + "–" + record.losses + (record.pushes > 0 ? "–" + record.pushes : "");
  return wl + " " + (record.source === "LEAGUE" ? leagueName.toUpperCase() + " " : "") + categoryLabel;
}

// Same form as the game card's price: "+120" / "-112".
export function formatPickOdds(odds: number): string {
  return (odds > 0 ? "+" : "") + odds;
}

// Football boards hold a Thursday-to-Monday week, so "today" would be wrong.
const WEEKLY_SLATE_LEAGUES = new Set(["NFL", "NCAAF"]);

export function slateCountText(leagueName: string, count: number): string {
  return (WEEKLY_SLATE_LEAGUES.has(leagueName.toUpperCase()) ? "This week" : "Today") + ": " + count + " pick" + (count === 1 ? "" : "s");
}

export function slateListHeader(leagueName: string, categoryLabel: string): string {
  return (WEEKLY_SLATE_LEAGUES.has(leagueName.toUpperCase()) ? "This Week's " : "Today's ") + categoryLabel + " Picks";
}

// The progressive reveal: `requested` rows are asked for (5, 10, 15, ...),
// `shown` is how many actually render, `more` is what the button would add
// (0 = no button).
export function revealState(requested: number, total: number): { shown: number; more: number; progress: string } {
  const shown = Math.max(0, Math.min(requested, total));
  return { shown, more: Math.min(LIVE_CATEGORY_REVEAL_STEP, total - shown), progress: shown + " of " + total };
}

export type LiveCategoryTile = {
  key: PickCategoryKey;
  label: string;
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
  slateCount: number;
};

// The tiles, in the league's chip-set order: every category with a graded
// record (as before), plus a 0-0 tile for a category that has slate picks but
// no graded history yet - there only while it has picks.
export function buildCategoryTiles(
  chipSet: { key: PickCategoryKey; label: string }[],
  breakdown: { key: PickCategoryKey; wins: number; losses: number; pushes: number; winPct: number }[],
  slateCounts: Map<PickCategoryKey, number>
): LiveCategoryTile[] {
  const byKey = new Map(breakdown.map((b) => [b.key, b]));
  const tiles: LiveCategoryTile[] = [];
  for (const { key, label } of chipSet) {
    const item = byKey.get(key);
    const slateCount = slateCounts.get(key) ?? 0;
    if (!item && slateCount === 0) continue;
    tiles.push({
      key,
      label,
      wins: item?.wins ?? 0,
      losses: item?.losses ?? 0,
      pushes: item?.pushes ?? 0,
      winPct: item?.winPct ?? 0,
      slateCount,
    });
  }
  return tiles;
}
