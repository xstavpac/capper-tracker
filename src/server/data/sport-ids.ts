// A sport's id by its name, memoized per process. The grade-picks cron (every
// 15 minutes) looked each graded sport up by name four times per run - once in
// each of gradeAllPendingPicks, regradeAllFuzzyMatchedPicks (grading.ts),
// gradeAllPendingLegs and regradeAllFuzzyMatchedLegs (parlay-grading.ts) - so
// about 1,700 one-row reads a day for ids that never change.
//
// Sports rows are never renamed or deleted, so a hit can't go stale. A miss is
// never cached: import-refs.ts creates a sport the first time an import names
// it, and the next lookup must see it. A cold instance reads once per sport,
// which is what every run did before.
import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { memoizeWithTtl } from "@/server/data/ttl-memo";

const SPORT_ID_TTL_MS = 60 * 60 * 1000;

// Rejecting is how a miss stays uncached: memoizeWithTtl drops a rejected entry.
class SportNotFound extends Error {}

export async function getSportIdByName(name: string): Promise<string | null> {
  try {
    return await memoizeWithTtl(
      cacheKeys.sportIdByName(name),
      async () => {
        const sport = await prisma.sport.findUnique({ where: { name }, select: { id: true } });
        if (!sport) throw new SportNotFound(name);
        return sport.id;
      },
      { ttlMs: SPORT_ID_TTL_MS }
    );
  } catch (err) {
    if (err instanceof SportNotFound) return null;
    throw err;
  }
}
