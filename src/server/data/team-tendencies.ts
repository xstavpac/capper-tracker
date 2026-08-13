import { prisma } from "@/lib/prisma";
import type { OddsGame } from "@/server/data/odds";
import { closestByTime, easternDateKey } from "@/lib/dates";
import { MAX_GAME_TIME_DRIFT_MS } from "@/server/data/grading";

// Below this many decided (non-push) games in a split, a team's tendency is
// too small a sample to be meaningful - the model builder's variable library
// hides/refuses to use a team's fav/dog/over/under rate until this is met.
// Matches this session's existing minimum-sample convention (RANKING_MIN_SAMPLE
// = 5 for capper stats, SCORECARD_MIN_SAMPLE = 5 for bet-type scorecards) scaled
// up for a per-team split, which sees far fewer games than an active capper does.
export const MIN_TENDENCY_SAMPLE = 20;

type TendencyAccumulator = {
  favWins: number;
  favLosses: number;
  favPushes: number;
  dogWins: number;
  dogLosses: number;
  dogPushes: number;
  overCount: number;
  underCount: number;
  totalPushCount: number;
};

function emptyAccumulator(): TendencyAccumulator {
  return {
    favWins: 0,
    favLosses: 0,
    favPushes: 0,
    dogWins: 0,
    dogLosses: 0,
    dogPushes: 0,
    overCount: 0,
    underCount: 0,
    totalPushCount: 0,
  };
}

// The odds-game matching this GameResult, if any - same "same two teams,
// which day's game" ambiguity findMatchingGameResult (grading.ts) solves,
// applied to OddsGame instead of GameResult. A game can appear in more than
// one daily snapshot if odds were fetched more than once before it started;
// closest-by-commence-time naturally collapses that to one.
export function findOddsGameForResult(
  oddsGames: OddsGame[],
  game: { homeTeam: string; awayTeam: string; gameDate: Date }
): OddsGame | null {
  const candidates = oddsGames.filter((g) => g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam);
  if (candidates.length === 0) return null;

  const withinDrift = candidates.filter(
    (g) => Math.abs(new Date(g.commenceTime).getTime() - game.gameDate.getTime()) <= MAX_GAME_TIME_DRIFT_MS
  );
  const pool = withinDrift.length > 0 ? withinDrift : candidates;
  if (pool.length === 1) return pool[0];
  return closestByTime(pool, (g) => new Date(g.commenceTime).getTime(), game.gameDate.getTime());
}

// First bookmaker's price for `teamName` in the moneyline (h2h) market -
// same "first bookmaker that has it" convention as findMarketPrice (odds.ts).
export function moneylinePrice(oddsGame: OddsGame, teamName: string): number | null {
  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === "h2h");
    const outcome = market?.outcomes.find((o) => o.name === teamName);
    if (outcome) return outcome.price;
  }
  return null;
}

// First bookmaker's totals line (the "point" shared by the Over/Under
// outcomes), regardless of which side it's read off.
export function totalLine(oddsGame: OddsGame): number | null {
  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === "totals");
    const point = market?.outcomes.find((o) => o.point !== undefined)?.point;
    if (point !== undefined) return point;
  }
  return null;
}

// The moneyline price attached to the Over or Under side of the totals
// market (the "juice") - needed to convert the total line into an implied
// probability instead of assuming a flat -110 on every book/game.
export function totalOutcomePrice(oddsGame: OddsGame, side: "Over" | "Under"): number | null {
  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === "totals");
    const outcome = market?.outcomes.find((o) => o.name === side);
    if (outcome) return outcome.price;
  }
  return null;
}

// First bookmaker's run-line (spread) point for `teamName`, e.g. -1.5 for a
// favorite. Independent of moneylinePrice's favorite/underdog determination -
// a team can be the moneyline favorite while still getting +1.5 on the run
// line, so this is read directly off the spreads market rather than derived.
export function spreadPoint(oddsGame: OddsGame, teamName: string): number | null {
  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === "spreads");
    const outcome = market?.outcomes.find((o) => o.name === teamName);
    if (outcome?.point !== undefined) return outcome.point;
  }
  return null;
}

// Rebuilds every team's TeamTendency row for a sport from scratch, by
// joining each finished GameResult against the odds snapshot for that same
// matchup (pregame favorite/underdog price + total line). Recomputes the
// full history every time rather than incrementally - GameResult/OddsSnapshot
// rows are never edited after creation, so this is cheap correctness insurance
// (a bug fix to the tendency logic self-heals on the next run) at the cost of
// redoing the join, which stays trivial at this data volume for the
// foreseeable future.
export async function recomputeTeamTendencies(sportKey: string): Promise<{ gamesProcessed: number; teamsUpdated: number }> {
  const [gameResults, snapshots] = await Promise.all([
    prisma.gameResult.findMany({ where: { sportKey } }),
    prisma.oddsSnapshot.findMany({ where: { sportKey } }),
  ]);

  const oddsGames: OddsGame[] = snapshots.flatMap((s) => s.data as unknown as OddsGame[]);

  const acc = new Map<string, TendencyAccumulator>();
  const getAcc = (teamName: string) => {
    let entry = acc.get(teamName);
    if (!entry) {
      entry = emptyAccumulator();
      acc.set(teamName, entry);
    }
    return entry;
  };

  let gamesProcessed = 0;

  for (const game of gameResults) {
    const oddsGame = findOddsGameForResult(oddsGames, game);
    if (!oddsGame) continue;

    let matchedAnything = false;

    const homePrice = moneylinePrice(oddsGame, game.homeTeam);
    const awayPrice = moneylinePrice(oddsGame, game.awayTeam);
    // Lower American-odds price = more favored (e.g. -150 < -110 < +100 <
    // +130). Skip if either side's price is missing, or if they're
    // (rarely) exactly equal - a true pick'em has no well-defined favorite.
    if (homePrice !== null && awayPrice !== null && homePrice !== awayPrice) {
      const favTeam = homePrice < awayPrice ? game.homeTeam : game.awayTeam;
      const dogTeam = favTeam === game.homeTeam ? game.awayTeam : game.homeTeam;
      const favAcc = getAcc(favTeam);
      const dogAcc = getAcc(dogTeam);

      if (game.homeScore === game.awayScore) {
        favAcc.favPushes++;
        dogAcc.dogPushes++;
      } else {
        const homeWon = game.homeScore > game.awayScore;
        const favWon = (favTeam === game.homeTeam) === homeWon;
        if (favWon) {
          favAcc.favWins++;
          dogAcc.dogLosses++;
        } else {
          favAcc.favLosses++;
          dogAcc.dogWins++;
        }
      }
      matchedAnything = true;
    }

    const line = totalLine(oddsGame);
    if (line !== null) {
      const actual = game.homeScore + game.awayScore;
      const homeAcc = getAcc(game.homeTeam);
      const awayAcc = getAcc(game.awayTeam);
      if (actual > line) {
        homeAcc.overCount++;
        awayAcc.overCount++;
      } else if (actual < line) {
        homeAcc.underCount++;
        awayAcc.underCount++;
      } else {
        homeAcc.totalPushCount++;
        awayAcc.totalPushCount++;
      }
      matchedAnything = true;
    }

    if (matchedAnything) gamesProcessed++;
  }

  await Promise.all(
    Array.from(acc.entries()).map(([teamName, counts]) =>
      prisma.teamTendency.upsert({
        where: { sportKey_teamName: { sportKey, teamName } },
        update: counts,
        create: { sportKey, teamName, ...counts },
      })
    )
  );

  return { gamesProcessed, teamsUpdated: acc.size };
}

// Copies today's cumulative TeamTendency rows into a dated
// TeamTendencySnapshot row each - purely a DB read-then-write, no external
// API calls, since recomputeTeamTendencies (called immediately before this
// in refresh-scores/route.ts) already did the actual work of computing these
// counts. Upserts, so a same-day cron retry overwrites rather than
// duplicating, same convention as the other snapshot capture functions.
export async function snapshotTeamTendencies(sportKey: string, date: string = easternDateKey(new Date())): Promise<number> {
  const rows = await prisma.teamTendency.findMany({ where: { sportKey } });

  await Promise.all(
    rows.map((row) =>
      prisma.teamTendencySnapshot.upsert({
        where: { sportKey_teamName_snapshotDate: { sportKey, teamName: row.teamName, snapshotDate: date } },
        update: {
          favWins: row.favWins,
          favLosses: row.favLosses,
          favPushes: row.favPushes,
          dogWins: row.dogWins,
          dogLosses: row.dogLosses,
          dogPushes: row.dogPushes,
          overCount: row.overCount,
          underCount: row.underCount,
          totalPushCount: row.totalPushCount,
        },
        create: {
          sportKey,
          teamName: row.teamName,
          snapshotDate: date,
          favWins: row.favWins,
          favLosses: row.favLosses,
          favPushes: row.favPushes,
          dogWins: row.dogWins,
          dogLosses: row.dogLosses,
          dogPushes: row.dogPushes,
          overCount: row.overCount,
          underCount: row.underCount,
          totalPushCount: row.totalPushCount,
        },
      })
    )
  );

  return rows.length;
}

export type TeamTendencyRates = {
  favWinPct: number | null;
  favSampleSize: number;
  dogWinPct: number | null;
  dogSampleSize: number;
  overRate: number | null;
  underRate: number | null;
  totalSampleSize: number;
};

// Converts a stored TeamTendency's raw counts into display-ready rates,
// gating each split independently on MIN_TENDENCY_SAMPLE - a team can have
// enough favorite-role games to show favWinPct while still lacking enough
// underdog-role games for dogWinPct, since MLB teams are favored/underdog at
// very different frequencies depending on how good they are.
export function computeTendencyRates(tendency: {
  favWins: number;
  favLosses: number;
  favPushes: number;
  dogWins: number;
  dogLosses: number;
  dogPushes: number;
  overCount: number;
  underCount: number;
  totalPushCount: number;
}): TeamTendencyRates {
  const favSampleSize = tendency.favWins + tendency.favLosses + tendency.favPushes;
  const dogSampleSize = tendency.dogWins + tendency.dogLosses + tendency.dogPushes;
  const totalSampleSize = tendency.overCount + tendency.underCount + tendency.totalPushCount;

  return {
    favWinPct: favSampleSize >= MIN_TENDENCY_SAMPLE ? tendency.favWins / favSampleSize : null,
    favSampleSize,
    dogWinPct: dogSampleSize >= MIN_TENDENCY_SAMPLE ? tendency.dogWins / dogSampleSize : null,
    dogSampleSize,
    overRate: totalSampleSize >= MIN_TENDENCY_SAMPLE ? tendency.overCount / totalSampleSize : null,
    underRate: totalSampleSize >= MIN_TENDENCY_SAMPLE ? tendency.underCount / totalSampleSize : null,
    totalSampleSize,
  };
}
