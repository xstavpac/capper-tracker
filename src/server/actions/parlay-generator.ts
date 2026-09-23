"use server";

// Auto-Generate (Parlay A + Hedge + Contrarian) for /parlay. Loads data only
// through what Live already uses (getLiveBoardData, getCapperLeagueRecords,
// getCapperCategoryRecords - all scoped to the signed-in user's own picks
// and cappers) and hands it to the pure builders in auto-generate.ts. Runs
// server-side because rankCandidates' module imports server/data/picks.
import { requireUser } from "@/server/auth";
import { LIVE_SPORTS } from "@/server/data/odds";
import { getLiveBoardData } from "@/server/data/live-board-picks";
import { getCapperCategoryRecords, getCapperLeagueRecords, type CapperLeagueRecords } from "@/server/data/picks";
import type { PickCategoryKey } from "@/server/data/stats";
import { easternDateKey } from "@/lib/dates";
import { AUTO_GENERATE_MAX_LEGS } from "@/lib/parlay/auto-generate-config";
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

export async function autoGenerateParlayAction(leagues: string[], legCount: number): Promise<AutoGenerateResult> {
  const user = await requireUser();
  const requested = Math.max(1, Math.min(AUTO_GENERATE_MAX_LEGS, Math.floor(legCount) || 1));
  const sports = LIVE_SPORTS.filter((s) => leagues.includes(s.label));

  const now = new Date();
  const todayKey = easternDateKey(now);
  const games: GeneratorGame[] = [];

  // Sequential, not Promise.all: each league's board load runs its own
  // picks query, and firing all of them at once is the connection-pool
  // pressure getPicksForGames' own comment warns about.
  for (const sport of sports) {
    const { odds, expanderPicksByGame } = await getLiveBoardData(user.id, sport.key, sport.label);
    odds.forEach((game, i) => {
      const start = new Date(game.commenceTime);
      if (easternDateKey(start) !== todayKey || start.getTime() <= now.getTime()) return;
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
