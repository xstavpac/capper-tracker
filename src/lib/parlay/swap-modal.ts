// What the Parlay Generator's leg cards and Swap modal show, as pure functions
// (generator-result.tsx renders them). Client-safe, no React.
import { combineOdds, payoutOn, type CombineLeg } from "@/lib/parlay/combine-odds";
import type { EngineLeg, LegSwapOptions, SwapOption, SwapTabKey } from "@/lib/parlay/generator";
import type { RankRecordSource } from "@/lib/parlay/pick-record";
import { PICK_CATEGORY_MARKET_NOUN, type PickCategoryKey } from "@/server/data/stats";
import { PROP_MARKET_LABELS, type PropMarketKey } from "@/lib/prop-market-key";

// ---- The modal's tabs ----------------------------------------------------------
export const SWAP_TAB_LABELS: Record<SwapTabKey, string> = { PRIMARY: "Primary", HEDGE: "Hedge", CONTRARIAN: "Contrarian", OTHER_GAMES: "Other games" };
export const SWAP_TAB_HELP: Record<SwapTabKey, string> = {
  PRIMARY: "Same side and market — alternate lines",
  HEDGE: "Same game — this pick's own team and game totals",
  CONTRARIAN: "Same game — the direct opposite and the opposing team",
  OTHER_GAMES: "Replace this leg with a pick from a game not in your parlay",
};
export const SWAP_EMPTY: Record<SwapTabKey, string> = {
  PRIMARY: "No other qualifying lines for this selection.",
  HEDGE: "No qualifying hedge alternatives for this selection.",
  CONTRARIAN: "No qualifying contrarian picks for this selection.",
  OTHER_GAMES: "No qualifying picks on games outside your parlay.",
};
export const OTHER_GAMES_NOTE = "Not in your parlay · clears your win-rate bar";

// The Other games tab's league chips: All, then each league present, in the order
// they first appear (the ranking order), each with how many rows it holds.
export function leagueChips(rows: readonly SwapOption[]): { league: string | null; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.pick.leagueName, (counts.get(r.pick.leagueName) ?? 0) + 1);
  return [{ league: null, count: rows.length }, ...Array.from(counts, ([league, count]) => ({ league, count }))];
}

// The rows a tab shows - every one, no cap - and so its count. Other games under a league chip: that league's.
export function tabRows(options: LegSwapOptions, tab: SwapTabKey, league: string | null = null): SwapOption[] {
  const rows = options[tab];
  return tab === "OTHER_GAMES" && league ? rows.filter((r) => r.pick.leagueName === league) : rows;
}

// ---- The record label ------------------------------------------------------------
// A bet category in plain words, capitalised: "Underdog spread", "First-5 over",
// "Team total", "NRFI". A player prop with a market key names its market
// ("Points", "Shots on goal"), never its category's catch-all "Player prop".
export function categoryName(category: PickCategoryKey | null | undefined, propMarket?: PropMarketKey): string {
  const noun = propMarket ? PROP_MARKET_LABELS[propMarket] : category ? PICK_CATEGORY_MARKET_NOUN[category] : null;
  return noun ? noun.charAt(0).toUpperCase() + noun.slice(1) : "This market";
}

// What a leg card and a swap-modal row say about the record (shownRecord): the real,
// unweighted record across every league, the category, and the in-league slice:
//   "50% (6–6) · Underdog spread · NFL 1–0"
// The slice shows even at 0–0 (no pick in this league yet). A slip pick with no
// category record shows its last 20 ("· last 20 picks"). No record: "No record yet".
export function legRecordLabel(
  record: { wins: number; losses: number; winPct: number } | null,
  basis: RankRecordSource | null,
  pick: { category?: PickCategoryKey | null; leagueName: string },
  propMarket?: PropMarketKey,
  leagueSlice?: { wins: number; losses: number }
): string {
  if (!record) return "No record yet";
  const base = `${Math.round(record.winPct)}% (${record.wins}–${record.losses})`;
  if (basis === "LAST20") return `${base} · last 20 picks`;
  if (basis === null) return base;
  // No slice given: a LEAGUE record is its own slice; an all-leagues one names no slice rather than guess.
  const slice = leagueSlice ?? (basis === "LEAGUE" ? record : null);
  return `${base} · ${categoryName(pick.category, propMarket)}` + (slice ? ` · ${pick.leagueName} ${slice.wins}–${slice.losses}` : "");
}

// ---- Win rate --------------------------------------------------------------------
// The colour of a leg's win % and its bar: 70+ deep green, 55-69 light green,
// under 55 amber; null (no record) muted. 75+ also gets the Hot tag.
export type WinTier = "STRONG" | "GOOD" | "LOW" | "NONE";
export const winTier = (winPct: number | null): WinTier => (winPct === null ? "NONE" : winPct >= 70 ? "STRONG" : winPct >= 55 ? "GOOD" : "LOW");
export const isHot = (winPct: number | null) => winPct !== null && winPct >= 75;

// ---- Leg order -------------------------------------------------------------------
// "Legs · strongest first": the engine's leg indexes by the win % each card shows
// (no record last), then the edge, then the engine's own order. Display only - the
// engine's legs and their indexes are unchanged.
export function strengthOrder(legs: readonly Pick<EngineLeg, "record" | "score">[]): number[] {
  return legs
    .map((l, i) => ({ i, pct: l.record?.winPct ?? -1, score: l.score ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => b.pct - a.pct || b.score - a.score || a.i - b.i)
    .map((x) => x.i);
}

// ---- League tags -----------------------------------------------------------------
// The coloured league tag on each card. Unlisted leagues are neutral.
export const LEAGUE_TAG: Record<string, string> = {
  NBA: "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  WNBA: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  NCAAB: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  NCAAF: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  NHL: "bg-slate-200 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300",
  NFL: "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  MLB: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
};
export const LEAGUE_TAG_DEFAULT = "bg-[#EEF0F5] text-foreground dark:bg-white/10";
export const leagueTagClass = (league: string) => LEAGUE_TAG[league.trim().toUpperCase()] ?? LEAGUE_TAG_DEFAULT;

// ---- The modal's footer ----------------------------------------------------------
// The combined price now and with this leg replaced, on $10. A parlay with two
// legs on one game is priced at FanDuel (as CombinedPrice); a leg with no price
// makes it Unavailable. `direction`: whether the $10 payout goes up or down.
export const SWAP_STAKE = 10;
export type PriceView = { kind: "PRICED"; american: number; payout: number; estimated: boolean } | { kind: "FANDUEL" } | { kind: "UNAVAILABLE" };

export function priceView(legs: readonly (CombineLeg & { gameId: string })[]): PriceView {
  if (new Set(legs.map((l) => l.gameId)).size < legs.length) return { kind: "FANDUEL" };
  const c = combineOdds([...legs]);
  if (c.status !== "AVAILABLE") return { kind: "UNAVAILABLE" };
  return { kind: "PRICED", american: c.american, payout: payoutOn(c, SWAP_STAKE), estimated: c.estimated };
}

export function swapComparison<L extends CombineLeg & { gameId: string }>(
  legs: readonly L[],
  index: number,
  replacement: L | null
): { now: PriceView; next: PriceView | null; direction: "UP" | "DOWN" | "SAME" | null } {
  const now = priceView(legs);
  if (!replacement) return { now, next: null, direction: null };
  const next = priceView(legs.map((l, i) => (i === index ? replacement : l)));
  const direction = now.kind === "PRICED" && next.kind === "PRICED" ? (next.payout > now.payout + 1e-9 ? "UP" : next.payout < now.payout - 1e-9 ? "DOWN" : "SAME") : null;
  return { now, next, direction };
}
