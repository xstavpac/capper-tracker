import { prisma } from "@/lib/prisma";
import type { PickStatus } from "@prisma/client";
import { matchGameResult, resolveOutcome, gradeTouchdownProp } from "@/server/data/grading";

// Concurrency cap for the bulk write passes below - same value and same
// reasoning as grading.ts's BULK_GRADE_CONCURRENCY (not shared/exported
// from there since these are independent tables with independent backlogs).
const BULK_GRADE_CONCURRENCY = 50;

// Re-evaluates one ParlayBet from its legs' current statuses, and writes the
// result IF AND ONLY IF the parlay is still PENDING at write time. Called
// after every leg write that leaves PENDING (see gradeAllPendingLegs and
// regradeAllFuzzyMatchedLegs below) - this is the only place ParlayBet.status
// is ever set to something other than its PENDING default.
//
// The "still PENDING" check is NOT a read-then-decide guard - it's baked
// into the WHERE clause of the write itself (prisma.parlayBet.updateMany
// below), so it's an atomic compare-and-swap at the database level, not
// something that can race:
//   - Two legs of the SAME parlay can legitimately finish in the same
//     concurrent grading batch (BULK_GRADE_CONCURRENCY = 50, so a LOSS leg
//     and a WIN leg can both call this function nearly simultaneously). Both
//     will read status: PENDING, both will compute a resolved status, but
//     only the first updateMany to actually reach Postgres can match a row -
//     the second's WHERE clause no longer matches (status is no longer
//     PENDING by then), so it silently updates zero rows. No lock needed.
//   - A trailing leg that finishes AFTER the parlay has already locked in
//     (e.g. leg 4 of 4 finishing days after leg 2 already decided the whole
//     parlay LOSS) calls this function too, same as any other leg update -
//     but its updateMany's WHERE clause finds status is already LOSS, not
//     PENDING, and again updates zero rows. There is no path by which a leg
//     finishing after the freeze can overwrite an already-written parent
//     outcome.
//
// Known limitation, accepted deliberately rather than fixed here: a fuzzy-
// match correction (regradeAllFuzzyMatchedLegs) to a leg that flips its
// result AFTER the parent has already resolved cannot un-freeze and correct
// the parent - the same PENDING-gated write applies to corrections as to
// first-time grading. Widening that would mean the parent is never truly
// final, which cuts against the "write once" guarantee this was built to
// preserve; flagged as a known trade-off rather than silently handled.
// Pure decision core (no DB I/O) - given every leg's current status, returns
// what the parlay's status should resolve to, or null if it isn't
// resolvable yet. Separated from recomputeParlayBetStatus's DB reads/writes
// so this rule set - the trickiest part of the whole feature - can be
// exercised directly by parlay-grading-acceptance-test.ts without needing a
// database, the same way grading.ts keeps gradePick/matchGameResult as pure
// functions independent of their I/O wrappers.
export function resolveParlayStatus(legStatuses: PickStatus[]): PickStatus | null {
  if (legStatuses.length === 0) return null;

  const hasLoss = legStatuses.some((s) => s === "LOSS");
  const hasPending = legStatuses.some((s) => s === "PENDING");

  if (hasLoss) {
    // Short-circuit: one LOSS decides the whole parlay immediately, even
    // while other legs are still PENDING (their games haven't finished, or
    // haven't started). Those legs keep grading normally in the background
    // via gradeAllPendingLegs - harmless, and never able to touch this
    // parlay again once it resolves (see recomputeParlayBetStatus's
    // updateMany guard).
    return "LOSS";
  }
  if (hasPending) {
    return null; // no loss yet, but still waiting on at least one leg - not resolvable yet
  }

  // Every leg is now WIN, PUSH, or CANCELLED (no PENDING, no LOSS). A push
  // or cancellation removes that leg from the parlay - "recalculates at N-1
  // legs" - so only WIN legs count as the parlay's effective legs.
  const effectiveLegCount = legStatuses.filter((s) => s === "WIN").length;
  // If every leg pushed/cancelled, there's no bet left to have won or lost -
  // the whole parlay pushes.
  return effectiveLegCount === 0 ? "PUSH" : "WIN";
}

export async function recomputeParlayBetStatus(parlayBetId: string): Promise<void> {
  const parlay = await prisma.parlayBet.findUnique({ where: { id: parlayBetId }, select: { status: true } });
  if (!parlay || parlay.status !== "PENDING") return; // already resolved (or gone) - nothing to recompute, nothing to write

  const legs = await prisma.leg.findMany({ where: { parlayBetId }, select: { status: true } });
  const resolvedStatus = resolveParlayStatus(legs.map((l) => l.status));
  if (!resolvedStatus) return; // not resolvable yet

  await prisma.parlayBet.updateMany({
    where: { id: parlayBetId, status: "PENDING" },
    data: { status: resolvedStatus, gradedAt: new Date() },
  });
}

// Recomputes every parlay touched by one grading pass, deduped - cheaper
// than calling recomputeParlayBetStatus once per leg, and still correct: the
// function is a no-op compare-and-swap once a parlay isn't PENDING anymore,
// so calling it more than once for the same parlay in the same pass (e.g.
// two of its legs both graded in this batch) is harmless.
async function recomputeAffectedParlays(parlayBetIds: string[]): Promise<void> {
  const unique = Array.from(new Set(parlayBetIds));
  await Promise.all(unique.map((id) => recomputeParlayBetStatus(id)));
}

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
        if (!result) return { matched: false, parlayBetId: leg.parlayBetId };

        const outcome =
          leg.betType === "PLAYER_PROP"
            ? await gradeTouchdownProp(leg, result.game.externalId)
            : resolveOutcome(leg, result.game);
        if (!outcome) return { matched: false, parlayBetId: leg.parlayBetId };

        await prisma.leg.update({
          where: { id: leg.id },
          data: { status: outcome, gradedAt: new Date(), gradedViaFuzzyMatch: result.matchType === "fuzzy" },
        });
        return { matched: true, parlayBetId: leg.parlayBetId };
      })
    );
    for (const o of outcomes) o.matched ? graded++ : notMatched++;

    // Recompute once per chunk (deduped), not once per leg - see
    // recomputeAffectedParlays.
    await recomputeAffectedParlays(outcomes.filter((o) => o.matched).map((o) => o.parlayBetId));
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
    const touchedParlayIds: string[] = [];
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
        if (changed) {
          upgraded++;
          touchedParlayIds.push(leg.parlayBetId);
        }
      })
    );

    // Only legs whose status actually changed can possibly move a parlay
    // out of PENDING (see recomputeParlayBetStatus's documented limitation:
    // a correction after the parent already resolved is a deliberate no-op,
    // so there's no point recomputing for legs whose correction happened
    // after the fact with no new information for a still-PENDING parent).
    await recomputeAffectedParlays(touchedParlayIds);
  }

  return { checked: fuzzyGraded.length, upgraded };
}
