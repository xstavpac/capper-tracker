// A started game's current price for a generator pick: FanDuel's in-play price, read off one Odds API listing
// per league (server/data/live-prices.ts, h2h / spreads / totals, bookmakers=fanduel). Client-safe and pure.
//
// What reads it:
//   - the -250 leg price floor (price-floor.ts belowPriceFloor): a generator-filled leg is capped on its
//     CURRENT price - the live price when there is one, else the posted price (the board is captured once in
//     the morning, so there is no later pregame price to fall back on). Slip picks are never capped.
//   - the card: a leg with a live price shows it (with a small "live" marker) instead of the posted price
//     and the "pregame line" label, and the combined odds use it.
//
// A live price exists only for the bet the pick actually is, at its own line: a full-game moneyline (the
// pick's team), spread (the pick's team at the pick's signed line) or total (Over / Under at the pick's
// line). Anything else - props, team totals, periods, a spread or total whose line FanDuel no longer hangs
// in-play - has none and keeps its posted price.
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import { isStarted } from "@/lib/parlay/game-progress";
import { totalSideFromText } from "@/lib/bet-line";

export type LiveOutcome = { name: string; price: number; point?: number | null };
export type LiveMarket = { key: string; outcomes: LiveOutcome[] };
// One in-play event from the listing, trimmed to FanDuel's three game-line markets.
export type LiveListingGame = { id: string; homeTeam: string; awayTeam: string; markets: LiveMarket[] };

// Per league, what the build had: the listing, or why not.
export type LivePriceStatus = "FETCHED" | "FAILED";
// The snapshot's record of live pricing:
//   asked   - the loader ran with "Include live games" on (off: never fetched, and a switch turned back on
//             needs a fresh snapshot - generator-session.ts);
//   leagues - per league that had a started game: FETCHED (a listing, possibly from the shared cache) or
//             FAILED (an error or a timeout - every pick there keeps its posted price).
export type LivePricing = { asked: boolean; leagues: Record<string, LivePriceStatus> };

const MARKET_OF: Record<string, string> = { MONEYLINE: "h2h", SPREAD: "spreads", TOTAL: "totals" };

// The pick's live price in `game`, or null when the listing has none for this exact bet.
export function livePriceFor(pick: Pick<GeneratorPick, "betType" | "period" | "teamGroup" | "line" | "betDetail">, game: LiveListingGame): number | null {
  if (pick.period !== "FULL_GAME") return null;
  const key = MARKET_OF[pick.betType];
  if (!key) return null;
  const market = game.markets.find((m) => m.key === key);
  if (!market) return null;
  let name: string;
  if (key === "totals") {
    const side = totalSideFromText(pick.betDetail);
    if (!side) return null;
    name = side === "OVER" ? "Over" : "Under";
  } else {
    // The board's own event: its home / away are the listing's (same Odds API event id), so the pick's
    // side group names the right outcome.
    if (pick.teamGroup !== "HOME" && pick.teamGroup !== "AWAY") return null;
    name = pick.teamGroup === "HOME" ? game.homeTeam : game.awayTeam;
  }
  const needsLine = key !== "h2h";
  if (needsLine && pick.line == null) return null;
  const outcome = market.outcomes.find((o) => o.name === name && (!needsLine || o.point === pick.line));
  return outcome && Number.isFinite(outcome.price) ? outcome.price : null;
}

// The leagues whose live prices a build needs: with "Include live games" on, every league with a started
// game (scheduled start passed, not over) in the pool. Off, or a pregame-only pool: none - no call.
export function leaguesNeedingLivePrices(games: Pick<GeneratorGame, "leagueName" | "gameTime" | "gameStatus" | "gameId">[], includeLive: boolean, now: Date): string[] {
  if (!includeLive) return [];
  return Array.from(new Set(games.filter((g) => isStarted(g, now)).map((g) => g.leagueName))).sort();
}

// Copies of the games and slip picks with each started game's picks carrying `liveOdds` where the league's
// listing prices them. A pick with no live price is returned as is.
export function withLivePrices<G extends { gameId: string; gameTime: string; gameStatus?: GeneratorGame["gameStatus"]; leagueName: string; picks: GeneratorPick[] }>(
  games: G[],
  slipPicks: GeneratorPick[],
  listings: Map<string, LiveListingGame[]>,
  now: Date
): { games: G[]; slipPicks: GeneratorPick[]; priced: number } {
  let priced = 0;
  const byLeague = new Map<string, Map<string, LiveListingGame>>();
  listings.forEach((list, league) => byLeague.set(league, new Map(list.map((g) => [g.id, g]))));
  const price = (p: GeneratorPick, started: boolean): GeneratorPick => {
    if (!started) return p;
    const listed = byLeague.get(p.leagueName)?.get(p.gameId);
    const live = listed ? livePriceFor(p, listed) : null;
    if (live === null) return p;
    priced++;
    return { ...p, liveOdds: live };
  };
  const outGames = games.map((g) => {
    const started = isStarted(g, now);
    return started ? { ...g, picks: g.picks.map((p) => price(p, true)) } : g;
  });
  const outSlip = slipPicks.map((p) => price(p, isStarted(p, now)));
  return { games: outGames, slipPicks: outSlip, priced };
}

// The price a leg is shown and combined at: its live price when it has one, else its posted price.
export function currentOdds(pick: { odds: number; liveOdds?: number | null }): number {
  return pick.liveOdds ?? pick.odds;
}
