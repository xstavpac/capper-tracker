// The "is this pasted pick already logged?" half of catalog-import duplicate
// detection (checkDuplicatePicksAction), as one database read for the whole
// paste instead of one per pick.
//
// It used to issue a pick.findMany per pasted pick that resolved to a game and
// an existing capper - about a hundred statements for a hundred-pick paste, all
// queued on the instance's small connection pool at once. Now:
//
//   existingPicksWhere(...)   one WHERE that is a SUPERSET of every per-pick
//                             query: this user's picks for the cappers and
//                             sports in the paste, across the span of the
//                             paste's game times (plus the drift tolerance).
//   dbDuplicateLabel(...)     re-applies, per pasted pick, EVERY predicate the
//                             old per-pick WHERE applied (capper, sport, home
//                             team, away team, game-time window) and then the
//                             same period / category / dedupCategory test.
//
// So the result is the same as long as both see the rows in the same order.
// The old query had no ORDER BY (whichever matching row Postgres returned first
// supplied the label); callers of this now order by id so the label is
// deterministic when a capper already has two matching rows.
//
// Parity with the per-pick version is proven by
// duplicate-db-match-acceptance-test.ts.
import type { Pick as PickRow, Prisma } from "@prisma/client";
import { betTypeLabel } from "@/lib/bet-line";
import { dedupCategory } from "@/lib/duplicate-pick-detection";
import { pickCategory } from "@/server/data/stats";

// Exactly the columns the match below reads - the full row (notes, timestamps,
// grading fields...) used to be fetched for every candidate.
export const EXISTING_PICK_SELECT = {
  capperId: true,
  sportId: true,
  homeTeam: true,
  awayTeam: true,
  gameTime: true,
  period: true,
  betType: true,
  betDetail: true,
  odds: true,
  line: true,
  pickedSide: true,
  mlFavoredSide: true,
  propMarket: true,
  playerName: true,
} as const satisfies Prisma.PickSelect;

export type ExistingPickRow = Pick<PickRow, keyof typeof EXISTING_PICK_SELECT>;

// One pasted pick that resolved to a real game, an existing capper and an
// existing sport - the only kind that can have a logged duplicate.
export type DbDupCandidate = {
  capperId: string;
  sportId: string;
  // The pasted pick's own sport label (what pickCategory needs to tell F5 from
  // a first half) - the existing row is categorized under it, as before.
  sportName: string;
  homeTeam: string;
  awayTeam: string;
  gameTimeMs: number;
  period: string;
  // dedupCategory(...) of the pasted pick.
  dedupKey: string;
};

// The one WHERE for the whole paste, or null when no pasted pick can have a
// logged duplicate (nothing to read). Deliberately coarse: homeTeam/awayTeam
// and each pick's own time window are applied in dbDuplicateLabel, so the
// statement stays small however many picks are pasted.
export function existingPicksWhere(
  userId: string,
  candidates: Pick<DbDupCandidate, "capperId" | "sportId" | "gameTimeMs">[],
  driftMs: number
): Prisma.PickWhereInput | null {
  if (candidates.length === 0) return null;
  const times = candidates.map((c) => c.gameTimeMs);
  return {
    userId,
    capperId: { in: Array.from(new Set(candidates.map((c) => c.capperId))) },
    sportId: { in: Array.from(new Set(candidates.map((c) => c.sportId))) },
    gameTime: { gte: new Date(Math.min(...times) - driftMs), lte: new Date(Math.max(...times) + driftMs) },
  };
}

// The label of the first logged pick that is the same bet as `candidate`, or
// null. `rows` may be the whole paste's superset read - everything the old
// per-pick WHERE filtered on is re-checked here.
export function dbDuplicateLabel(rows: ExistingPickRow[], candidate: DbDupCandidate, driftMs: number): string | null {
  const dbDup = rows.find((p) => {
    if (p.capperId !== candidate.capperId || p.sportId !== candidate.sportId) return false;
    if (p.homeTeam !== candidate.homeTeam || p.awayTeam !== candidate.awayTeam) return false;
    if (Math.abs(p.gameTime.getTime() - candidate.gameTimeMs) > driftMs) return false;
    // Scoped to sportId above so "same game" here matches what
    // getPicksForGame (picks.ts) considers the same game - without that
    // scope, a same-named team in a different sport (or a stale/mis-resolved
    // row) could flag a duplicate that the game's own expander would never
    // actually show, since getPicksForGame always filters by sportId too.
    // period is compared explicitly (not just via pickCategory): a Q1 /
    // 2nd-half / period pick shares the plain OVER/UNDER/ML/SPREAD category
    // with its full-game counterpart.
    if (p.period !== candidate.period) return false;
    const pCategory = pickCategory({ ...p, sportName: candidate.sportName });
    if (!pCategory) return false;
    // p.propMarket/p.playerName are the row's own stored columns (set at
    // import time) - pass them through directly so dedupCategory doesn't need
    // to re-derive them from betDetail; null for any row predating those
    // columns, which dedupCategory falls back to re-parsing.
    const knownPlayerProp = p.propMarket && p.playerName ? { propMarket: p.propMarket, playerName: p.playerName } : null;
    return dedupCategory(pCategory, p.betType, p.betDetail, p.pickedSide, knownPlayerProp) === candidate.dedupKey;
  });
  return dbDup ? dbDup.betDetail || betTypeLabel(dbDup.betType) : null;
}

// Sport ids for the paste's sport names, matched case-insensitively as the old
// per-name findFirst did. `sports` is one findMany for all the names, ordered
// by id, so a name with case-variant rows resolves to the same row every time.
export function sportIdsByLowerName(sports: { id: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sports) {
    const key = s.name.toLowerCase();
    if (!out.has(key)) out.set(key, s.id);
  }
  return out;
}
