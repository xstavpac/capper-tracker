// Frozen copy of the pre-migration raw-pick JS path for getCapperCategoryRecords /
// getCapperLeagueRecords (formerly picks.ts's private fetchPicksByCapper + the two
// exported functions built on it) - kept ONLY as the parity reference for
// picks-by-capper-aggregates-acceptance-test.ts (and, if wired in, the T2 harness's
// `legacy` registry entry). See docs/design/picks-by-capper-egress.md.
//
// NO production code calls anything in this file - picks.ts's getCapperCategoryRecords
// / getCapperLeagueRecords now go through getCapperRecordBundle (the SQL path). This
// file is deleted in the removal PR (design doc §10, step 5) once the SQL path has
// had an observation period.
//
// Deliberately unchanged from the pre-migration implementation (same behavior,
// including its undefined same-gameTime tie order - design doc §4.1) except for the
// rename itself, so a diff against it is a diff against exactly what production used
// to run.
import { prisma } from "@/lib/prisma";
import {
  computeStats,
  computeCategoryBreakdown,
  computeLeagueRecordCards,
  recentPicksRecord,
  ALL_CATEGORY_KEYS,
  LEAGUE_RECORD_LAST_N,
  CATEGORY_RECENT_FORM_MIN_SAMPLE,
  CATEGORY_RECENT_FORM_WINDOW,
  type CategoryBreakdownItem,
  type LeagueRecordCard,
  type LeagueRecordColumn,
  type PickCategoryKey,
} from "@/server/data/stats";
import type { GameCardStreak } from "@/lib/game-card-record-line";
import { leagueRecordKey, categoryRecordKey, type CapperLeagueRecords } from "@/server/data/picks";

async function fetchPicksByCapperLegacy(userId: string, capperIds: string[]) {
  const picks = await prisma.pick.findMany({
    where: { userId, capperId: { in: capperIds } },
    include: { sport: { select: { name: true } } },
  });
  const byCapper = new Map<string, typeof picks>();
  for (const pick of picks) {
    const list = byCapper.get(pick.capperId);
    if (list) list.push(pick);
    else byCapper.set(pick.capperId, [pick]);
  }
  return byCapper;
}

export async function getCapperCategoryRecordsLegacy(
  userId: string,
  pairs: { capperId: string; category: PickCategoryKey }[]
): Promise<Record<string, CategoryBreakdownItem | null>> {
  const capperIds = Array.from(new Set(pairs.map((p) => p.capperId)));
  if (capperIds.length === 0) return {};

  const byCapper = await fetchPicksByCapperLegacy(userId, capperIds);

  const breakdownByCapper = new Map<string, Map<PickCategoryKey, CategoryBreakdownItem>>();
  for (const capperId of capperIds) {
    const items = computeCategoryBreakdown(byCapper.get(capperId) ?? [], ALL_CATEGORY_KEYS, {
      window: CATEGORY_RECENT_FORM_WINDOW,
      minSample: CATEGORY_RECENT_FORM_MIN_SAMPLE,
    });
    breakdownByCapper.set(capperId, new Map(items.map((i) => [i.key, i])));
  }

  const out: Record<string, CategoryBreakdownItem | null> = {};
  for (const { capperId, category } of pairs) {
    out[categoryRecordKey(capperId, category)] = breakdownByCapper.get(capperId)?.get(category) ?? null;
  }
  return out;
}

export async function getCapperLeagueRecordsLegacy(
  userId: string,
  entries: { capperId: string; leagueSport: string; category: PickCategoryKey | null }[]
): Promise<CapperLeagueRecords> {
  const capperIds = Array.from(new Set(entries.map((e) => e.capperId)));
  if (capperIds.length === 0) return { records: {}, streaks: {}, last20: {} };

  const pairs = entries.filter(
    (e): e is { capperId: string; leagueSport: string; category: PickCategoryKey } => e.category !== null
  );

  const byCapper = await fetchPicksByCapperLegacy(userId, capperIds);

  const cardsByCapperLeague = new Map<string, Map<PickCategoryKey, LeagueRecordCard>>();
  const seen = new Set<string>();
  for (const { capperId, leagueSport } of pairs) {
    const k = capperId + "|" + leagueSport;
    if (seen.has(k)) continue;
    seen.add(k);
    const cards = computeLeagueRecordCards(byCapper.get(capperId) ?? [], leagueSport, ALL_CATEGORY_KEYS);
    cardsByCapperLeague.set(k, new Map(cards.map((c) => [c.category, c])));
  }

  const streaks: Record<string, GameCardStreak> = {};
  for (const capperId of capperIds) {
    streaks[capperId] = computeStats(byCapper.get(capperId) ?? []).currentStreak;
  }

  const last20: Record<string, LeagueRecordColumn | null> = {};
  for (const capperId of capperIds) {
    last20[capperId] = recentPicksRecord(byCapper.get(capperId) ?? [], LEAGUE_RECORD_LAST_N, LEAGUE_RECORD_LAST_N);
  }

  const records: Record<string, LeagueRecordCard | null> = {};
  for (const { capperId, leagueSport, category } of pairs) {
    records[leagueRecordKey(capperId, leagueSport, category)] =
      cardsByCapperLeague.get(capperId + "|" + leagueSport)?.get(category) ?? null;
  }
  return { records, streaks, last20 };
}
