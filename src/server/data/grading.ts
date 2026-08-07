import { prisma } from "@/lib/prisma";
import { getLiveScoresForSport, getMlbFirstFiveScore } from "@/server/data/odds";
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

  let saved = 0;
  for (const g of finals) {
    const homeScore = g.scores!.find((s) => s.name === g.homeTeam)?.score;
    const awayScore = g.scores!.find((s) => s.name === g.awayTeam)?.score;
    if (homeScore === undefined || awayScore === undefined) continue;

    const existing = await prisma.gameResult.findUnique({
      where: { sportKey_externalId: { sportKey, externalId: g.id } },
    });

    // First-five is immutable once captured, and fetching it hits the heavier
    // live-feed endpoint - only fetch it the first time this game is persisted.
    const needsFirstFive = supportsFirstFive && (!existing || existing.firstFiveHomeScore === null);
    const firstFive = needsFirstFive ? await getMlbFirstFiveScore(g.id) : null;

    await prisma.gameResult.upsert({
      where: { sportKey_externalId: { sportKey, externalId: g.id } },
      update: {
        homeScore: parseInt(homeScore, 10),
        awayScore: parseInt(awayScore, 10),
        ...(firstFive ? { firstFiveHomeScore: firstFive.home, firstFiveAwayScore: firstFive.away } : {}),
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
        gameDate: new Date(g.commenceTime),
      },
    });
    saved++;
  }

  return saved;
}

function teamNickname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

type GradeOutcome = "WIN" | "LOSS" | "PUSH" | null;

function gradePick(
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

  return null;
}

function closestByDate<T extends { gameDate: Date }>(items: T[], reference: Date): T {
  return closestByTime(items, (item) => item.gameDate.getTime(), reference.getTime());
}

async function findMatchingGameResult(
  sportKey: string,
  pick: {
    gameTime: Date;
    homeTeam: string;
    awayTeam: string;
    betDetail: string | null;
  }
) {
  const windowStart = new Date(pick.gameTime.getTime() - 2 * 86400000);
  const windowEnd = new Date(pick.gameTime.getTime() + 2 * 86400000);

  const candidates = await prisma.gameResult.findMany({
    where: { sportKey, gameDate: { gte: windowStart, lt: windowEnd } },
  });
  if (candidates.length === 0) return null;

  // Picks resolved to a real game on import (see resolveGameForNickname) carry the
  // exact team names, so prefer an exact match over the fuzzy text search below.
  const exact = candidates.filter((c) => c.homeTeam === pick.homeTeam && c.awayTeam === pick.awayTeam);
  if (exact.length > 0) return closestByDate(exact, pick.gameTime);

  // Legacy/manual picks may only have raw text in homeTeam/betDetail - fall back to
  // matching by team nickname substring.
  const searchText = ((pick.betDetail ?? "") + " " + pick.homeTeam + " " + pick.awayTeam).toLowerCase();
  const fuzzy = candidates.filter(
    (c) => searchText.includes(teamNickname(c.homeTeam)) || searchText.includes(teamNickname(c.awayTeam))
  );
  if (fuzzy.length === 0) return null;
  return closestByDate(fuzzy, pick.gameTime);
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
    const match = await findMatchingGameResult(sportKey, pick);

    if (!match) {
      notMatched++;
      continue;
    }

    const homeScore = pick.period === "FIRST_HALF" ? match.firstFiveHomeScore : match.homeScore;
    const awayScore = pick.period === "FIRST_HALF" ? match.firstFiveAwayScore : match.awayScore;

    if (homeScore === null || awayScore === null) {
      notMatched++;
      continue;
    }

    const outcome = gradePick(
      pick.betType,
      pick.betDetail ?? pick.homeTeam,
      pick.line,
      match.homeTeam,
      match.awayTeam,
      homeScore,
      awayScore
    );

    if (!outcome) {
      notMatched++;
      continue;
    }

    await prisma.pick.update({ where: { id: pick.id }, data: { status: outcome, gradedAt: new Date() } });
    graded++;
  }

  return { graded, notMatched };
}

