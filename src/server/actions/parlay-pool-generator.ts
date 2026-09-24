"use server";

// Auto Hedge / Contrarian for the Select-Your-Own-Picks flow (/parlay's "My
// Picks" section - see docs/parlay-white-paper.md Section 2.1, three modes
// over one primary pool). Mirrors autoGenerateParlayAction's shape
// (parlay-generator.ts) closely on purpose: same getLiveBoardData/
// getCapperCategoryRecords calls, same buildSwapParlay call - the only new
// piece is buildPoolPrimary (lib/parlay/pool-swap.ts), which builds the
// primary parlay from the user's pool instead of the full slate's top pick
// per game. Runs server-side because buildPoolPrimary/buildSwapParlay's
// module graph reaches server/data/picks + prisma.
import { requireUser } from "@/server/auth";
import { LIVE_SPORTS } from "@/server/data/odds";
import { getLiveBoardData } from "@/server/data/live-board-picks";
import { getCapperCategoryRecords, getCapperLeagueRecords, type CapperLeagueRecords } from "@/server/data/picks";
import type { PickCategoryKey } from "@/server/data/stats";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { buildPoolPrimary, excludeSelectedPicks } from "@/lib/parlay/pool-swap";
import type { SkippedPick, UnverifiedPair } from "@/lib/parlay/build-my-picks";
import {
  buildSwapParlay,
  type AutoParlay,
  type GeneratorGame,
  type GeneratorPick,
  type SwapMode,
  type SwapParlay,
} from "@/lib/parlay/auto-generate";

export type PoolSwapResult = {
  parlayA: AutoParlay; // the primary legs Hedge/Contrarian swapped from - same construction as My Picks
  swap: SwapParlay;
  skipped: SkippedPick[];
  unverified: UnverifiedPair[];
  requested: number;
  shortfall: number;
  // For PickCard's record block on every rendered pick.
  records: CapperLeagueRecords;
  leaguesSearched: string[];
};

// `pool` is the pool picks the caller wants considered - already filtered to
// in-scope leagues by the caller (ParlayPoolSection), same convention as
// buildMyPicks() there. No fixed leg ceiling: bounded only by however many
// conflict-free legs the pool can supply (see build-my-picks.ts) - unlike
// Auto-Generate's AUTO_GENERATE_MAX_LEGS, which doesn't apply to this path.
export async function generatePoolSwapAction(
  pool: ExpanderPick[],
  legCount: number,
  mode: SwapMode
): Promise<PoolSwapResult> {
  const user = await requireUser();
  const requested = Math.max(1, Math.floor(legCount) || 1);

  // GeneratorPick requires datePosted: string; a pool pick persisted to
  // localStorage before that field existed (or otherwise missing it) still
  // needs a value here. Default to the pick's own gameTime (posted no later
  // than kickoff) rather than drop the pick - it's never read for gating
  // this pick's OWN eligibility (contrarianHeadcountPasses never checks the
  // primary's own datePosted, see qualification-ranking.ts), and this pick
  // never re-enters as someone ELSE's alternate candidate: alternates only
  // ever come from the freshly-fetched `games` catalog below, never the pool.
  const poolPicks: GeneratorPick[] = pool.map((p) => ({ ...p, datePosted: p.datePosted ?? p.gameTime }));

  const records = await getCapperLeagueRecords(
    user.id,
    poolPicks.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }))
  );

  const primary = buildPoolPrimary(poolPicks, records, requested);

  // Only fetch alternates for leagues actually present in the built primary
  // legs (not every league in the pool, and not every configured league) -
  // buildSwapParlay only ever looks up a leg's own gameId, so any other
  // league's slate would never be read. Keeps getLiveBoardData calls to at
  // most one per distinct league among the primary's own legs.
  const leaguesInPrimary = Array.from(new Set(primary.parlayA.legs.map((l) => l.top.pick.leagueName)));
  const sports = LIVE_SPORTS.filter((s) => leaguesInPrimary.includes(s.label));

  const now = new Date();
  const games: GeneratorGame[] = [];
  // Sequential, not Promise.all - same connection-pool reasoning as
  // autoGenerateParlayAction (parlay-generator.ts).
  for (const sport of sports) {
    const { odds, expanderPicksByGame } = await getLiveBoardData(user.id, sport.key, sport.label);
    odds.forEach((game, i) => {
      const start = new Date(game.commenceTime);
      // Only an unstarted game can offer a substitution. A primary leg whose
      // game already started, or whose gameId never appears in this fetched
      // slate at all, simply has no entry in `games` - buildSwapParlay
      // already treats a missing gameId as "no alternates" and keeps that
      // leg unchanged (auto-generate.ts: `picksByGame.get(leg.gameId) ?? []`).
      if (start.getTime() <= now.getTime()) return;
      const picks = expanderPicksByGame[i].filter(
        (p): p is GeneratorPick => p.status === "PENDING" && typeof p.datePosted === "string"
      );
      games.push({
        gameId: game.id,
        gameLabel: picks[0]?.gameLabel ?? game.awayTeam + " @ " + game.homeTeam,
        gameTime: game.commenceTime,
        leagueName: sport.label,
        picks,
      });
    });
  }

  // See excludeSelectedPicks' own comment (lib/parlay/pool-swap.ts): a
  // pool-driven primary can have two legs from the same game, so a sibling
  // leg's own pick must never resurface as a "swap" suggestion for another
  // leg in that game.
  const gamesForSwap = excludeSelectedPicks(games, primary.parlayA);

  const allPicks = gamesForSwap.flatMap((g) => g.picks);
  const categoryRecords = await getCapperCategoryRecords(
    user.id,
    allPicks
      .filter((p): p is GeneratorPick & { category: PickCategoryKey } => p.category !== null)
      .map((p) => ({ capperId: p.capperId, category: p.category }))
  );

  // The `records` fetched above only covers the pool's own picks (what
  // buildPoolPrimary needed to rank them) - a swap's alternate pick belongs
  // to a different capper entirely, so PickCard would render it with no
  // record at all without also covering the catalog. Re-fetch over the
  // union, same shape autoGenerateParlayAction fetches for its own full
  // slate (parlay-generator.ts).
  const renderRecords = await getCapperLeagueRecords(
    user.id,
    [...poolPicks, ...allPicks].map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }))
  );

  return {
    parlayA: primary.parlayA,
    swap: buildSwapParlay(primary.parlayA, gamesForSwap, mode, categoryRecords),
    skipped: primary.skipped,
    unverified: primary.unverified,
    requested: primary.requested,
    shortfall: primary.shortfall,
    records: renderRecords,
    leaguesSearched: sports.map((s) => s.label),
  };
}
