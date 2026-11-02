// The platform rates behind the Parlay Generator's scoring module (lib/parlay/scoring.ts): win and break-even
// totals per league + bet type + key, across every user, as aggregates only.
//
// Write path (the only one): the nightly refresh-scores cron, then revalidateTag(platformRatesTag).
//
// Egress: the recompute runs inside Postgres and returns two counts. A cache miss reads the whole small table
// (7 columns, one row per league + bet type + key), shared across users, at most daily. Nothing reads it yet: the
// Standard generator switch does.
import { Prisma } from "@prisma/client";
import { cacheKeys } from "@/lib/cache-keys";
import { PROP_MARKET_KEYS, propMarketOf, sportsOfPropFamily, type PropMarketKey } from "@/lib/prop-market-key";
import type { PlatformRateRow } from "@/lib/parlay/scoring";
import { prisma } from "@/lib/prisma";
import { cachedByTag } from "@/server/data/cached";
import { realBreakEvenSql } from "@/server/data/real-price-sql";

const CACHE_SECONDS = 24 * 3600;

// (sport, market, key) for every league of every family: what turns a prop's stored market into its key, exactly
// as propMarketKey does. A market with no key here keeps the pick's category.
function marketKeyRows(): Prisma.Sql {
  const rows = PROP_MARKET_KEYS.flatMap((key: PropMarketKey) =>
    sportsOfPropFamily(key.slice(0, key.indexOf(":"))).map((sport) => Prisma.sql`(${sport}::text, ${propMarketOf(key)}::text, ${key}::text)`)
  );
  return Prisma.join(rows);
}

export function buildPlatformRatesRecompute(): Prisma.Sql {
  return Prisma.sql`
    WITH market_keys(sport, market, key) AS (VALUES ${marketKeyRows()}),
    agg AS (
      SELECT s.name AS league, p."betType"::text AS "betType", COALESCE(m.key, p.category) AS key,
        (count(*) FILTER (WHERE p.status = 'WIN'))::int AS wins,
        (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS losses,
        COALESCE(round(sum(x.be), 4), 0)::float8 AS "impliedSum",
        (count(x.be))::int AS priced
      FROM picks p
      JOIN sports s ON s.id = p."sportId"
      LEFT JOIN market_keys m ON p."betType" = 'PLAYER_PROP' AND m.sport = upper(s.name) AND m.market = p."propMarket"::text
      CROSS JOIN LATERAL (SELECT ${Prisma.raw(realBreakEvenSql("p"))} AS be) x
      WHERE p.status IN ('WIN', 'LOSS') AND NOT p."isRecipientCopy" AND COALESCE(m.key, p.category) IS NOT NULL
      GROUP BY 1, 2, 3
    ),
    up AS (
      INSERT INTO platform_category_rates (id, league, "betType", key, wins, losses, "impliedSum", priced, "computedAt")
      SELECT gen_random_uuid()::text, league, "betType", key, wins, losses, "impliedSum", priced, now() FROM agg
      ON CONFLICT (league, "betType", key) DO UPDATE
        SET wins = EXCLUDED.wins, losses = EXCLUDED.losses, "impliedSum" = EXCLUDED."impliedSum", priced = EXCLUDED.priced, "computedAt" = EXCLUDED."computedAt"
      RETURNING id
    ),
    gone AS (
      DELETE FROM platform_category_rates WHERE id NOT IN (SELECT id FROM up) RETURNING id
    )
    SELECT (SELECT count(*) FROM up)::int AS written, (SELECT count(*) FROM gone)::int AS removed
  `;
}

export async function recomputePlatformCategoryRates(): Promise<{ written: number; removed: number }> {
  const rows = await prisma.$queryRaw<{ written: number; removed: number }[]>(buildPlatformRatesRecompute());
  return rows[0];
}

// Every row: a platform's table is small and shared, so it is read whole, once, and each snapshot takes what it needs.
export function getPlatformCategoryRates(): Promise<PlatformRateRow[]> {
  return cachedByTag(
    cacheKeys.platformRates(),
    CACHE_SECONDS,
    () => prisma.platformCategoryRate.findMany({ select: { league: true, betType: true, key: true, wins: true, losses: true, impliedSum: true, priced: true } }),
    [cacheKeys.platformRates()]
  );
}
