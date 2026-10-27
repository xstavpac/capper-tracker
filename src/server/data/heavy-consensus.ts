// Heavy Consensus history: the stored markets behind the Live tab's hit rate,
// and the cached read of that rate. Every rule (what qualifies, the outcome
// vote, the one-per-real-world-market pooling) lives in lib/heavy-consensus.ts;
// this file only moves rows.
//
// Write paths (the only ones - nothing else touches heavy_consensus_markets):
//   - the nightly recompute in refresh-scores (recomputeHeavyConsensusMarkets
//     with the default window), then revalidateTag(heavyConsensusRate);
//   - scripts/backfill-heavy-consensus.ts (window: all history), run by hand
//     once after the migration is live. It has no Next context to revalidate
//     in; the rate's 24 h TTL picks it up.
// User deletion cascades rows away; the rate then catches up on the next
// recompute's revalidate or its TTL.
//
// Egress: the recompute reads the window's full-game ML / spread / total picks
// (12 small columns, the last HEAVY_CONSENSUS_WINDOW_DAYS + 1 days) plus the
// window's stored rows' (id, userId, worldKey); a cache miss on the rate reads
// 5 small columns of every stored row (a few hundred rows, ~20 KB).
import { prisma } from "@/lib/prisma";
import { cachedByTag } from "@/server/data/cached";
import { cacheKeys } from "@/lib/cache-keys";
import { easternDateKey } from "@/lib/dates";
import { classifyPickTeamGroup } from "@/lib/pick-team-group";
import {
  buildHeavyConsensusInstances,
  pooledHeavyConsensusRate,
  type HeavyConsensusInstance,
  type HeavyConsensusRate,
  type HeavyOutcome,
  type HistoryPick,
} from "@/lib/heavy-consensus";

// Eastern dates the nightly pass recomputes, today included: long enough for a
// late grade (grade-picks runs every 15 min, but a stuck pick can take days).
export const HEAVY_CONSENSUS_WINDOW_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const RATE_TTL_SECONDS = 24 * 60 * 60;

export type HeavyConsensusRecompute = {
  // The first Eastern date recomputed, or null for all history.
  fromDate: string | null;
  picksRead: number;
  markets: number;
  upserted: number;
  deleted: number;
};

export const heavyConsensusWindowStart = (now: Date) => easternDateKey(new Date(now.getTime() - (HEAVY_CONSENSUS_WINDOW_DAYS - 1) * DAY_MS));

// Recomputes the stored markets on games from `fromDate` (an Eastern date key)
// on, or all history when null: upserts every market that qualifies now and
// deletes, by id, the stored ones in that range that no longer do.
export async function recomputeHeavyConsensusMarkets(
  now: Date = new Date(),
  fromDate: string | null = heavyConsensusWindowStart(now)
): Promise<HeavyConsensusRecompute> {
  const { picksRead, instances } = await loadHeavyConsensusInstances(now, fromDate);

  const stored = await prisma.heavyConsensusMarket.findMany({
    where: fromDate === null ? {} : { gameDate: { gte: fromDate } },
    select: { id: true, userId: true, worldKey: true },
  });
  const fresh = new Set(instances.map((i) => i.userId + "\u0000" + i.worldKey));
  const staleIds = stored.filter((s) => !fresh.has(s.userId + "\u0000" + s.worldKey)).map((s) => s.id);

  const computedAt = new Date();
  const data = (i: HeavyConsensusInstance) => ({
    sport: i.sport,
    gameDate: i.gameDate,
    gameTime: i.gameTime,
    market: i.market,
    heavySide: i.side,
    cappers: i.cappers,
    heavyCappers: i.heavyCappers,
    sharePct: i.sharePct,
    band: i.band,
    outcome: i.outcome,
    computedAt,
  });
  await prisma.$transaction([
    ...instances.map((i) =>
      prisma.heavyConsensusMarket.upsert({
        where: { userId_worldKey: { userId: i.userId, worldKey: i.worldKey } },
        create: { userId: i.userId, worldKey: i.worldKey, ...data(i) },
        update: data(i),
      })
    ),
    ...(staleIds.length > 0 ? [prisma.heavyConsensusMarket.deleteMany({ where: { id: { in: staleIds } } })] : []),
  ]);

  return { fromDate, picksRead, markets: instances.length, upserted: instances.length, deleted: staleIds.length };
}

// The read half of the recompute, on its own so the backfill can dry-run it:
// the qualifying per-viewer markets on games from `fromDate` on (all when null).
export async function loadHeavyConsensusInstances(now: Date, fromDate: string | null): Promise<{ picksRead: number; instances: HeavyConsensusInstance[] }> {
  // One day of slack before the window so every pick on its first Eastern date is read.
  const readFrom = fromDate === null ? undefined : new Date(Date.parse(fromDate + "T00:00:00Z") - DAY_MS);
  const rows = await prisma.pick.findMany({
    where: {
      period: "FULL_GAME",
      betType: { in: ["MONEYLINE", "SPREAD", "TOTAL"] },
      status: { not: "CANCELLED" },
      gameTime: { lt: now, ...(readFrom ? { gte: readFrom } : {}) },
      capper: { isTest: false },
    },
    select: {
      userId: true,
      capperId: true,
      homeTeam: true,
      awayTeam: true,
      betType: true,
      betDetail: true,
      period: true,
      pickedSide: true,
      gameTime: true,
      gameNumber: true,
      status: true,
      datePosted: true,
      sport: { select: { name: true } },
    },
  });

  const picks: HistoryPick[] = rows.map((r) => ({
    userId: r.userId,
    capperId: r.capperId,
    sport: r.sport.name,
    homeTeam: r.homeTeam,
    awayTeam: r.awayTeam,
    gameNumber: r.gameNumber,
    betType: r.betType,
    period: r.period,
    betDetail: r.betDetail,
    teamGroup: classifyPickTeamGroup(r, r, r.sport.name),
    status: r.status,
    gameTime: r.gameTime,
    datePosted: r.datePosted,
  }));
  const instances = buildHeavyConsensusInstances(picks).filter((i) => fromDate === null || i.gameDate >= fromDate);
  return { picksRead: rows.length, instances };
}

// The pooled hit rate the Live badge shows, cached for every viewer. A failed
// read is null (no pill anywhere) rather than an error: the badge is optional,
// and the Live page must still render. Errors are never cached (cachedByTag),
// so the next load retries.
export function getHeavyConsensusRate(): Promise<HeavyConsensusRate | null> {
  return cachedByTag(cacheKeys.heavyConsensusRate(), RATE_TTL_SECONDS, async () => {
    const rows = await prisma.heavyConsensusMarket.findMany({
      select: { userId: true, worldKey: true, cappers: true, sharePct: true, outcome: true },
    });
    return pooledHeavyConsensusRate(rows.map((r) => ({ ...r, outcome: r.outcome as HeavyOutcome | null })));
  }).catch((err: unknown) => {
    console.error("getHeavyConsensusRate failed", err);
    return null;
  });
}
