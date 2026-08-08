import { prisma } from "@/lib/prisma";
import type { GameResult } from "@prisma/client";
import { getLiveScoresForSport, getMlbEarlyInningScores } from "@/server/data/odds";
import { closestByTime } from "@/lib/dates";
import { extractLine } from "@/lib/bet-line";

// Persists final scores for a sport's finished games into GameResult, so
// gradePendingPicks has something to grade against. First-five (F5) scores
// are MLB-only for now - no free box-score-by-half source is wired up for
// other sports yet, so period=FIRST_HALF picks in those sports just won't
// match (see gradePendingPicks) until that's built.
export async function persistFinalScores(sportKey: string): Promise<number> {
  const games = await getLiveScoresForSport(sportKey);
  const finals = games.filter((g) => g.status === "final" && g.scores);
  const supportsFirstFive = sportKey === "baseball_mlb";

  // Each game's persist is independent - was previously a sequential for-loop,
  // which meant a day with many newly-final games (each potentially needing a
  // first-five fetch against MLB's heavier live-feed endpoint) made every
  // Picks page load wait on the sum of all of them instead of the slowest one.
  const results = await Promise.all(
    finals.map(async (g) => {
      const homeScore = g.scores!.find((s) => s.name === g.homeTeam)?.score;
      const awayScore = g.scores!.find((s) => s.name === g.awayTeam)?.score;
      if (homeScore === undefined || awayScore === undefined) return false;

      const existing = await prisma.gameResult.findUnique({
        where: { sportKey_externalId: { sportKey, externalId: g.id } },
      });

      // Early-inning scores are immutable once captured, and fetching them hits the
      // heavier live-feed endpoint - only fetch what's still missing. Checking both
      // fields (not just firstFive) matters for GameResult rows persisted before
      // first-inning capture existed - those already have firstFive set, so a
      // firstFive-only check would skip them and leave firstInning null forever.
      const needsEarlyInnings =
        supportsFirstFive && (!existing || existing.firstFiveHomeScore === null || existing.firstInningHomeScore === null);
      const early = needsEarlyInnings ? await getMlbEarlyInningScores(g.id) : null;
      const firstFive = early?.firstFive ?? null;
      const firstInning = early?.firstInning ?? null;

      await prisma.gameResult.upsert({
        where: { sportKey_externalId: { sportKey, externalId: g.id } },
        update: {
          homeScore: parseInt(homeScore, 10),
          awayScore: parseInt(awayScore, 10),
          ...(firstFive ? { firstFiveHomeScore: firstFive.home, firstFiveAwayScore: firstFive.away } : {}),
          ...(firstInning
            ? { firstInningHomeScore: firstInning.home, firstInningAwayScore: firstInning.away }
            : {}),
        },
        create: {
          sportKey,
          externalId: g.id,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          homeScore: parseInt(homeScore, 10),
          awayScore: parseInt(awayScore, 10),
          firstFiveHomeScore: firstFive?.home ?? null,
          firstFiveAwayScore: firstFive?.away ?? null,
          firstInningHomeScore: firstInning?.home ?? null,
          firstInningAwayScore: firstInning?.away ?? null,
          gameDate: new Date(g.commenceTime),
        },
      });
      return true;
    })
  );

  return results.filter(Boolean).length;
}

function teamNickname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

type GradeOutcome = "WIN" | "LOSS" | "PUSH" | null;

export function gradePick(
  betType: string,
  betDetail: string,
  line: number | null,
  homeTeam: string,
  awayTeam: string,
  homeScore: number,
  awayScore: number
): GradeOutcome {
  const detail = betDetail.toLowerCase();
  const homeNick = teamNickname(homeTeam);
  const awayNick = teamNickname(awayTeam);

  const pickedHome = detail.includes(homeNick);
  const pickedAway = detail.includes(awayNick);

  if (betType === "MONEYLINE") {
    if (pickedHome && homeScore > awayScore) return "WIN";
    if (pickedHome && homeScore < awayScore) return "LOSS";
    if (pickedAway && awayScore > homeScore) return "WIN";
    if (pickedAway && awayScore < homeScore) return "LOSS";
    if (homeScore === awayScore) return "PUSH";
    return null;
  }

  if (betType === "SPREAD") {
    // Prefer the line stored at pick-creation time; older picks fall back to
    // regex-parsing it out of the free-text betDetail.
    const spread = line ?? extractLine("SPREAD", detail);
    if (spread === null) return null;

    if (pickedHome) {
      const adjusted = homeScore + spread;
      if (adjusted > awayScore) return "WIN";
      if (adjusted < awayScore) return "LOSS";
      return "PUSH";
    }
    if (pickedAway) {
      const adjusted = awayScore + spread;
      if (adjusted > homeScore) return "WIN";
      if (adjusted < homeScore) return "LOSS";
      return "PUSH";
    }
    return null;
  }

  if (betType === "TOTAL") {
    const totalLine = line ?? extractLine("TOTAL", detail);
    if (totalLine === null) return null;
    const actual = homeScore + awayScore;
    const isOver = detail.includes("over");
    const isUnder = detail.includes("under");

    if (isOver) {
      if (actual > totalLine) return "WIN";
      if (actual < totalLine) return "LOSS";
      return "PUSH";
    }
    if (isUnder) {
      if (actual < totalLine) return "WIN";
      if (actual > totalLine) return "LOSS";
      return "PUSH";
    }
    return null;
  }

  if (betType === "NRFI") {
    // Binary market on combined (both teams') first-inning runs - no push.
    // homeScore/awayScore here are the game's first-inning scores, not final
    // (see gradePendingPicks, which selects the score source by betType).
    const runsScored = homeScore + awayScore;
    const pickedNoRun = detail.includes("nrfi") || detail.includes("no run");
    const pickedYesRun = detail.includes("yrfi") || detail.includes("yes run") || detail.includes("run 1st");

    if (pickedNoRun) return runsScored === 0 ? "WIN" : "LOSS";
    if (pickedYesRun) return runsScored > 0 ? "WIN" : "LOSS";
    return null;
  }

  return null;
}

function closestByDate<T extends { gameDate: Date }>(items: T[], reference: Date): T {
  return closestByTime(items, (item) => item.gameDate.getTime(), reference.getTime());
}

type GameMatch = { game: GameResult; matchType: "exact" | "fuzzy" };

export async function findMatchingGameResult(
  sportKey: string,
  pick: {
    gameTime: Date;
    homeTeam: string;
    awayTeam: string;
    betDetail: string | null;
  }
): Promise<GameMatch | null> {
  const windowStart = new Date(pick.gameTime.getTime() - 2 * 86400000);
  const windowEnd = new Date(pick.gameTime.getTime() + 2 * 86400000);

  const candidates = await prisma.gameResult.findMany({
    where: { sportKey, gameDate: { gte: windowStart, lt: windowEnd } },
  });
  if (candidates.length === 0) return null;

  // Picks resolved to a real game on import (see resolveGameForNickname) carry the
  // exact team names, so prefer an exact match over the fuzzy text search below.
  const exact = candidates.filter((c) => c.homeTeam === pick.homeTeam && c.awayTeam === pick.awayTeam);
  if (exact.length > 0) return { game: closestByDate(exact, pick.gameTime), matchType: "exact" };

  // Legacy/manual picks may only have raw text in homeTeam/betDetail - fall back to
  // matching by team nickname substring. Requires BOTH teams' nicknames to appear,
  // not just one - matching on a single side let this latch onto a candidate that
  // shares one team but is actually a different matchup entirely (e.g. a pick's own
  // game result hasn't been persisted yet, so this fell through to some other game
  // that same team played on an adjacent day, against a different opponent, and
  // silently graded against that instead). Requiring both sides keeps the fallback
  // scoped to "this exact matchup, just spelled differently" the way it was intended.
  const searchText = ((pick.betDetail ?? "") + " " + pick.homeTeam + " " + pick.awayTeam).toLowerCase();
  const fuzzy = candidates.filter(
    (c) => searchText.includes(teamNickname(c.homeTeam)) && searchText.includes(teamNickname(c.awayTeam))
  );
  if (fuzzy.length === 0) return null;
  return { game: closestByDate(fuzzy, pick.gameTime), matchType: "fuzzy" };
}

// Shared by gradePendingPicks and regradeFuzzyMatchedPicks - picks the right score
// pair for the bet (final / first-five / first-inning) and runs gradePick.
function resolveOutcome(
  pick: { betType: string; period: string; betDetail: string | null; homeTeam: string; line: number | null },
  game: GameResult
): GradeOutcome {
  const homeScore =
    pick.betType === "NRFI"
      ? game.firstInningHomeScore
      : pick.period === "FIRST_HALF"
        ? game.firstFiveHomeScore
        : game.homeScore;
  const awayScore =
    pick.betType === "NRFI"
      ? game.firstInningAwayScore
      : pick.period === "FIRST_HALF"
        ? game.firstFiveAwayScore
        : game.awayScore;

  if (homeScore === null || awayScore === null) return null;

  return gradePick(pick.betType, pick.betDetail ?? pick.homeTeam, pick.line, game.homeTeam, game.awayTeam, homeScore, awayScore);
}

export async function gradePendingPicks(
  userId: string,
  sportName: string,
  sportKey: string
): Promise<{
  graded: number;
  notMatched: number;
}> {
  const pendingPicks = await prisma.pick.findMany({
    where: { userId, status: "PENDING", sport: { name: sportName } },
  });

  let graded = 0;
  let notMatched = 0;

  for (const pick of pendingPicks) {
    const result = await findMatchingGameResult(sportKey, pick);
    if (!result) {
      notMatched++;
      continue;
    }

    const outcome = resolveOutcome(pick, result.game);
    if (!outcome) {
      notMatched++;
      continue;
    }

    await prisma.pick.update({
      where: { id: pick.id },
      data: { status: outcome, gradedAt: new Date(), gradedViaFuzzyMatch: result.matchType === "fuzzy" },
    });
    graded++;
  }

  return { graded, notMatched };
}

// A fuzzy match is the best information available at grading time, but it's still a
// guess scoped to "this team, roughly this date" rather than a confirmed same-game
// match. Once a real exact-team-name GameResult shows up for the game, re-grade
// against that instead - this is what let the Tigers/Giants mis-grades go
// undetected: they were graded fuzzy, then never looked at again even after the
// correct game result was persisted. Only picks currently flagged fuzzy are
// checked - exact matches are already the highest-confidence result there is, and
// manually-graded picks (gradedViaFuzzyMatch null) are intentionally never touched.
export async function regradeFuzzyMatchedPicks(
  userId: string,
  sportName: string,
  sportKey: string
): Promise<{ checked: number; upgraded: number }> {
  const fuzzyGraded = await prisma.pick.findMany({
    where: { userId, sport: { name: sportName }, status: { in: ["WIN", "LOSS", "PUSH"] }, gradedViaFuzzyMatch: true },
  });

  let upgraded = 0;

  for (const pick of fuzzyGraded) {
    const result = await findMatchingGameResult(sportKey, pick);
    if (!result || result.matchType !== "exact") continue;

    const outcome = resolveOutcome(pick, result.game);
    if (!outcome) continue;

    const changed = outcome !== pick.status;
    // gradedAt intentionally untouched - this corrects the original grading, it
    // isn't a new grading event, so it shouldn't reorder recent-form panels.
    await prisma.pick.update({ where: { id: pick.id }, data: { status: outcome, gradedViaFuzzyMatch: false } });
    if (changed) upgraded++;
  }

  return { checked: fuzzyGraded.length, upgraded };
}

