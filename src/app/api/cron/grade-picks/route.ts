import { revalidateTag } from "next/cache";
import { persistFinalScores, gradeAllPendingPicks, regradeAllFuzzyMatchedPicks } from "@/server/data/grading";
import { gradeAllPendingLegs, regradeAllFuzzyMatchedLegs } from "@/server/data/parlay-grading";
import { RESOLVABLE_SPORT_KEYS, LIVE_SPORTS } from "@/server/data/odds";
import { cacheKeys } from "@/lib/cache-keys";

export const dynamic = "force-dynamic";
// Pro plan default (15s) isn't enough headroom for a sport with a large
// pending backlog (score fetch + GameResult query + up to 500 picks' worth
// of matching/writes). Bounded well under Pro's 300s ceiling - if a run ever
// needs longer than this, that's a signal to lower maxPicks per gradeAllPendingPicks
// call, not to keep raising this.
export const maxDuration = 60;

// Runs every 15 minutes (see vercel.json) - the automatic counterpart to the
// page-load grading /picks and /live/[gameId] already do. Those two remain
// in place as a fast path (nobody waits 15 minutes to see a pick they just
// watched finish); this route is what grades everyone else's picks even when
// no one happens to be looking at those two pages. Every sport in
// RESOLVABLE_SPORT_KEYS gets its scores refreshed and its pending picks
// (across ALL users, not just whoever's browsing) graded in the same run.
// Parlay legs are the one exception to the page-load fast path - they have
// no page-load-triggered grading yet, so this cron is the only place they
// get graded at all (see parlay-grading.ts). Each leg grade/regrade pass
// also recomputes any ParlayBet it may have just resolved.
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== "Bearer " + cronSecret) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const results = await Promise.all(
    RESOLVABLE_SPORT_KEYS.map(async (sportKey) => {
      const sportName = LIVE_SPORTS.find((s) => s.key === sportKey)?.label;
      if (!sportName) return { sport: sportKey, skipped: true, changedUserIds: new Set<string>() };

      const persisted = await persistFinalScores(sportKey);
      const grading = await gradeAllPendingPicks(sportKey, sportName);
      const regrading = await regradeAllFuzzyMatchedPicks(sportKey, sportName);
      const legGrading = await gradeAllPendingLegs(sportKey, sportName);
      const legRegrading = await regradeAllFuzzyMatchedLegs(sportKey, sportName);
      return {
        sport: sportKey,
        persisted,
        grading,
        regrading,
        legGrading,
        legRegrading,
        changedUserIds: new Set([...grading.changedUserIds, ...regrading.changedUserIds]),
      };
    })
  );

  // Only the users whose pick status actually changed this run get their
  // Dashboard/Reports caches busted - never a global flush. Leg grading is
  // deliberately not included: those cached surfaces read only Pick rows
  // (parlay stats are a separate uncached query).
  const changedUserIds = new Set<string>(results.flatMap((r) => [...r.changedUserIds]));
  for (const userId of changedUserIds) {
    revalidateTag(cacheKeys.dashboard(userId));
    revalidateTag(cacheKeys.reports(userId));
  }

  return Response.json({
    ok: true,
    invalidatedUsers: changedUserIds.size,
    results: results.map(({ changedUserIds: _o, grading, regrading, ...rest }) => ({
      ...rest,
      ...(grading ? { grading: { graded: grading.graded, notMatched: grading.notMatched, remaining: grading.remaining } } : {}),
      ...(regrading ? { regrading: { checked: regrading.checked, upgraded: regrading.upgraded } } : {}),
    })),
  });
}
