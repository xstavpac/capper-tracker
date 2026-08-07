import { prisma } from "@/lib/prisma";
import { getMlbLiveScores } from "@/server/data/odds";
import { closestByTime } from "@/lib/dates";

export async function persistMlbFinalScores(): Promise<number> {
  const games = await getMlbLiveScores();
  const finals = games.filter((g) => g.status === "final" && g.scores);

  let saved = 0;
  for (const g of finals) {
    const homeScore = g.scores!.find((s) => s.name === g.homeTeam)?.score;
    const awayScore = g.scores!.find((s) => s.name === g.awayTeam)?.score;
    if (homeScore === undefined || awayScore === undefined) continue;

    await prisma.gameResult.upsert({
      where: { sportKey_externalId: { sportKey: "baseball_mlb", externalId: g.id } },
      update: { homeScore: parseInt(homeScore, 10), awayScore: parseInt(awayScore, 10) },
      create: {
        sportKey: "baseball_mlb",
        externalId: g.id,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        homeScore: parseInt(homeScore, 10),
        awayScore: parseInt(awayScore, 10),
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
    const spreadMatch = detail.match(/([+-]\d+(\.\d+)?)/);
    if (!spreadMatch) return null;
    const spread = parseFloat(spreadMatch[1]);

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
    const numberMatch = detail.match(/(\d+(\.\d+)?)/);
    if (!numberMatch) return null;
    const line = parseFloat(numberMatch[1]);
    const actual = homeScore + awayScore;
    const isOver = detail.includes("over");
    const isUnder = detail.includes("under");

    if (isOver) {
      if (actual > line) return "WIN";
      if (actual < line) return "LOSS";
      return "PUSH";
    }
    if (isUnder) {
      if (actual < line) return "WIN";
      if (actual > line) return "LOSS";
      return "PUSH";
    }
    return null;
  }

  return null;
}

function closestByDate<T extends { gameDate: Date }>(items: T[], reference: Date): T {
  return closestByTime(items, (item) => item.gameDate.getTime(), reference.getTime());
}

async function findMatchingGameResult(pick: {
  gameTime: Date;
  homeTeam: string;
  awayTeam: string;
  betDetail: string | null;
}) {
  const windowStart = new Date(pick.gameTime.getTime() - 2 * 86400000);
  const windowEnd = new Date(pick.gameTime.getTime() + 2 * 86400000);

  const candidates = await prisma.gameResult.findMany({
    where: { sportKey: "baseball_mlb", gameDate: { gte: windowStart, lt: windowEnd } },
  });
  if (candidates.length === 0) return null;

  // Picks resolved to a real game on import (see resolveMlbGameForNickname) carry the
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

export async function gradePendingPicks(userId: string): Promise<{
  graded: number;
  notMatched: number;
}> {
  const pendingPicks = await prisma.pick.findMany({
    where: { userId, status: "PENDING", sport: { name: "MLB" } },
  });

  let graded = 0;
  let notMatched = 0;

  for (const pick of pendingPicks) {
    const match = await findMatchingGameResult(pick);

    if (!match) {
      notMatched++;
      continue;
    }

    const outcome = gradePick(
      pick.betType,
      pick.betDetail ?? pick.homeTeam,
      match.homeTeam,
      match.awayTeam,
      match.homeScore,
      match.awayScore
    );

    if (!outcome) {
      notMatched++;
      continue;
    }

    await prisma.pick.update({ where: { id: pick.id }, data: { status: outcome } });
    graded++;
  }

  return { graded, notMatched };
}

