"use server";

// Auto-Generate (Parlay A + Hedge + Contrarian) for /parlay, over each
// league's unstarted games in its window (auto-generate-window.ts: today, or
// the football week for NFL/NCAAF). Loads data only
// through what Live already uses (getLiveBoardData, getCapperLeagueRecords,
// getCapperCategoryRecords - all scoped to the signed-in user's own picks
// and cappers) and hands it to the pure builders in auto-generate.ts. Runs
// server-side because rankCandidates' module imports server/data/picks.
import { requireUser } from "@/server/auth";
import { LIVE_SPORTS } from "@/server/data/odds";
import { getLiveBoardData } from "@/server/data/live-board-picks";
import { getCapperCategoryRecords, getCapperLeagueRecords, type CapperLeagueRecords } from "@/server/data/picks";
import type { PickCategoryKey } from "@/server/data/stats";
import { legCapRejection, type LegCapRejection } from "@/lib/parlay/leg-cap";
import { autoGenerateWindow } from "@/lib/parlay/auto-generate-window";
import {
  buildAutoParlay,
  buildSwapParlay,
  type AutoParlay,
  type GeneratorGame,
  type GeneratorPick,
  type SwapParlay,
} from "@/lib/parlay/auto-generate";

export type AutoGenerateResult = {
  parlayA: AutoParlay;
  hedge: SwapParlay;
  contrarian: SwapParlay;
  // For PickCard's record block on every rendered pick.
  records: CapperLeagueRecords;
  leaguesSearched: string[];
};

// More than MAX_PARLAY_LEGS legs is refused outright (see leg-cap.ts) - never
// built smaller than asked.
export async function autoGenerateParlayAction(
  leagues: string[],
  legCount: number
): Promise<AutoGenerateResult | LegCapRejection> {
  const user = await requireUser();
  const rejection = legCapRejection(legCount);
  if (rejection) return rejection;
  const requested = Math.max(1, Math.floor(legCount) || 1);
  const sports = LIVE_SPORTS.filter((s) => leagues.includes(s.label));

  const now = new Date();
  const games: GeneratorGame[] = [];

  // Sequential, not Promise.all: each league's board load runs its own
  // picks query, and firing all of them at once is the connection-pool
  // pressure getPicksForGames' own comment warns about.
  for (const sport of sports) {
    const { odds, expanderPicksByGame } = await getLiveBoardData(user.id, sport.key, sport.label);
    const inWindow = autoGenerateWindow(
      sport.label,
      odds.map((g) => g.commenceTime),
      now
    );
    odds.forEach((game, i) => {
      if (!inWindow(game.commenceTime)) return;
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

  const allPicks = games.flatMap((g) => g.picks);
  const [records, categoryRecords] = await Promise.all([
    getCapperLeagueRecords(
      user.id,
      allPicks.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }))
    ),
    getCapperCategoryRecords(
      user.id,
      allPicks
        .filter((p): p is GeneratorPick & { category: PickCategoryKey } => p.category !== null)
        .map((p) => ({ capperId: p.capperId, category: p.category }))
    ),
  ]);

  const parlayA = buildAutoParlay(games, records, requested);
  return {
    parlayA,
    hedge: buildSwapParlay(parlayA, games, "AUTO_HEDGE", categoryRecords),
    contrarian: buildSwapParlay(parlayA, games, "CONTRARIAN", categoryRecords),
    records,
    leaguesSearched: sports.map((s) => s.label),
  };
}
