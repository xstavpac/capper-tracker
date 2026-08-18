import { prisma } from "@/lib/prisma";
import { matchGameResult, resolveOutcome, gradeTouchdownProp } from "@/server/data/grading";

// Concurrency cap for the bulk write passes below - same value and same
// reasoning as grading.ts's BULK_GRADE_CONCURRENCY (not shared/exported
// from there since these are independent tables with independent backlogs).
const BULK_GRADE_CONCURRENCY = 50;

// Leg-level grading only - this file does not yet know ParlayBet exists.
// Deliberately scoped this way: a Leg is shaped identically to a Pick for
// grading purposes (same homeTeam/awayTeam/betType/line/period/gameTime
// fields), so matchGameResult/resolveOutcome/gradeTouchdownProp - already
// pure, structurally-typed functions in grading.ts - grade a Leg exactly the
// way they grade a Pick today, unchanged. The one thing that IS different
// (a leg's grading has to trigger its parent ParlayBet to re-evaluate) is
// deliberately left for the next layer (recomputeParlayBetStatus) rather
// than folded in here, so this file can be verified as "grades individual
// legs correctly" on its own before the parent-recompute state machine is
// layered on top of it.
//
// Global counterpart to a per-user gradePendingPicks - grades every user's
// pending legs for a sport in one pass. Scoped to the cron path only for v1:
// unlike Pick, there is no page-load-triggered instant grading for legs yet
// (/picks and /live/[gameId] only ever call the Pick versions) - a parlay
// leg still grades within the normal 15-minute cron cadence, just not the
// instant a game finishes if someone happens to be looking at the page.
export async function gradeAllPendingLegs(
  sportKey: string,
  sportName: string,
  maxLegs = 500
): Promise<{ graded: number; notMatched: number; remaining: number }> {
  const sport = await prisma.sport.findUnique({ where: { name: sportName } });
  if (!sport) return { graded: 0, notMatched: 0, remaining: 0 };

  const totalPending = await prisma.leg.count({ where: { sportId: sport.id, status: "PENDING" } });
  if (totalPending === 0) return { graded: 0, notMatched: 0, remaining: 0 };

  const toProcess = await prisma.leg.findMany({
    where: { sportId: sport.id, status: "PENDING" },
    orderBy: { gameTime: "asc" },
    take: maxLegs,
  });
  const remaining = totalPending - toProcess.length;

  const minTime = Math.min(...toProcess.map((l) => l.gameTime.getTime())) - 2 * 86400000;
  const maxTime = Math.max(...toProcess.map((l) => l.gameTime.getTime())) + 2 * 86400000;
  const candidates = await prisma.gameResult.findMany({
    where: { sportKey, gameDate: { gte: new Date(minTime), lt: new Date(maxTime) } },
  });

  let graded = 0;
  let notMatched = 0;

  for (let i = 0; i < toProcess.length; i += BULK_GRADE_CONCURRENCY) {
    const chunk = toProcess.slice(i, i + BULK_GRADE_CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(async (leg) => {
        const result = matchGameResult(candidates, leg);
        if (!result) return false;

        const outcome =
          leg.betType === "PLAYER_PROP"
            ? await gradeTouchdownProp(leg, result.game.externalId)
            : resolveOutcome(leg, result.game);
        if (!outcome) return false;

        await prisma.leg.update({
          where: { id: leg.id },
          data: { status: outcome, gradedAt: new Date(), gradedViaFuzzyMatch: result.matchType === "fuzzy" },
        });
        return true;
      })
    );
    for (const matched of outcomes) matched ? graded++ : notMatched++;
  }

  return { graded, notMatched, remaining };
}

// Global counterpart to regradeAllFuzzyMatchedPicks - same "upgrade a fuzzy
// match to an exact one once a better GameResult shows up" logic, applied to
// Leg rows instead of Pick rows.
export async function regradeAllFuzzyMatchedLegs(
  sportKey: string,
  sportName: string
): Promise<{ checked: number; upgraded: number }> {
  const sport = await prisma.sport.findUnique({ where: { name: sportName } });
  if (!sport) return { checked: 0, upgraded: 0 };

  const fuzzyGraded = await prisma.leg.findMany({
    where: { sport: { id: sport.id }, status: { in: ["WIN", "LOSS", "PUSH"] }, gradedViaFuzzyMatch: true },
  });
  if (fuzzyGraded.length === 0) return { checked: 0, upgraded: 0 };

  const minTime = Math.min(...fuzzyGraded.map((l) => l.gameTime.getTime())) - 2 * 86400000;
  const maxTime = Math.max(...fuzzyGraded.map((l) => l.gameTime.getTime())) + 2 * 86400000;
  const candidates = await prisma.gameResult.findMany({
    where: { sportKey, gameDate: { gte: new Date(minTime), lt: new Date(maxTime) } },
  });

  let upgraded = 0;

  for (let i = 0; i < fuzzyGraded.length; i += BULK_GRADE_CONCURRENCY) {
    const chunk = fuzzyGraded.slice(i, i + BULK_GRADE_CONCURRENCY);
    await Promise.all(
      chunk.map(async (leg) => {
        const result = matchGameResult(candidates, leg);
        if (!result || result.matchType !== "exact") return;

        const outcome =
          leg.betType === "PLAYER_PROP"
            ? await gradeTouchdownProp(leg, result.game.externalId)
            : resolveOutcome(leg, result.game);
        if (!outcome) return;

        const changed = outcome !== leg.status;
        // gradedAt intentionally untouched - same reasoning as
        // regradeFuzzyMatchedPicks: this corrects the original grading, it
        // isn't a new grading event.
        await prisma.leg.update({ where: { id: leg.id }, data: { status: outcome, gradedViaFuzzyMatch: false } });
        if (changed) upgraded++;
      })
    );
  }

  return { checked: fuzzyGraded.length, upgraded };
}
