// "Load older picks" on /picks: the server half (the pure half and the page
// size are in lib/older-picks.ts). Each click reads picks strictly older than
// the page's date window, newest first, keyset-paged on (gameTime, id) - the
// first page's read and everything computed from it are untouched.
//
// Every read here is bounded: the picks read has LIMIT 51 and runs at most
// OLDER_PICKS_MAX_PAGES_PER_CLICK times per click; names, records and final
// scores follow that page's rows only.
import { PropMarket, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { easternDayStart, easternDateKey } from "@/lib/dates";
import { betTypeFilterCategory } from "@/lib/bet-type-filter";
import { LIVE_WINDOW_MS } from "@/lib/pick-display";
import {
  OLDER_PICKS_MAX_PAGES_PER_CLICK,
  OLDER_PICKS_MIN_VISIBLE,
  OLDER_PICKS_PAGE_SIZE,
  type OlderPicksCursor,
  type OlderPicksQuery,
} from "@/lib/older-picks";
import { FILTERED_PICK_SELECT, withCapperAndSportNames } from "@/server/data/picks";
import { getCapperAllTimeRecords, getFeedStatusesForPicks, getFinalScoresForPicks } from "@/server/data/picks-summary";
import { toLedgerPick, toLedgerRow, type LedgerSourcePick } from "@/server/data/picks-ledger-rows";
import type { LedgerRow } from "@/components/picks/pick-ledger";
import type { PickStatus } from "@prisma/client";

const PROP_MARKETS = new Set<string>(Object.values(PropMarket));
const FULL_GAME_KEYS: Record<string, "SPREAD" | "MONEYLINE" | "TOTAL"> = { SPREAD: "SPREAD", MONEYLINE: "MONEYLINE", TOTAL: "TOTAL" };
const FIRST_HALF_KEYS: Record<string, "SPREAD" | "MONEYLINE" | "TOTAL"> = { F5_SPREAD: "SPREAD", F5_MONEYLINE: "MONEYLINE", F5_TOTAL: "TOTAL" };

// The part of a bet-type filter key (lib/bet-type-filter.ts) the database can
// apply: every row betTypeFilterCategory gives `key` matches this, and most
// rows that match it get `key` - the exceptions (NRFI vs YRFI, read from the
// bet text; a prop with no stored propMarket, parsed from the text) are cut in
// memory after the read, with the same function the first page uses. null for
// a key that no pick can have.
export function betTypeWhere(key: string): Prisma.PickWhereInput | null {
  if (key === "NRFI" || key === "YRFI") return { betType: "NRFI" };
  if (key === "TEAM_TOTAL") return { betType: "TEAM_TOTAL" };
  if (FIRST_HALF_KEYS[key]) return { betType: FIRST_HALF_KEYS[key], period: "FIRST_HALF" };
  if (FULL_GAME_KEYS[key]) return { betType: FULL_GAME_KEYS[key], period: { not: "FIRST_HALF" } };
  if (PROP_MARKETS.has(key)) return { betType: "PLAYER_PROP", OR: [{ propMarket: key as PropMarket }, { propMarket: null }] };
  return null;
}

// Rows older than the window start (or today's start, if the window is in the
// future - those rows belong to Today, not to history).
export function olderPicksCutoff(before: string, now: Date): Date {
  return new Date(Math.min(easternDayStart(before).getTime(), easternDayStart(easternDateKey(now)).getTime()));
}

// One page's WHERE. The redundant `gameTime <= cursor` lets Postgres start the
// (userId, gameTime) index scan at the cursor instead of at the cutoff (without
// it, page N walks and discards every row of pages 1..N-1).
export function olderPicksWhere(userId: string, q: OlderPicksQuery, cutoff: Date, cursor: OlderPicksCursor | null): Prisma.PickWhereInput {
  const and: Prisma.PickWhereInput[] = [{ gameTime: { lt: cutoff } }];
  if (cursor) {
    const t = new Date(cursor.gameTime);
    and.push({ gameTime: { lte: t } }, { OR: [{ gameTime: { lt: t } }, { gameTime: t, id: { lt: cursor.id } }] });
  }
  const bet = q.betType ? betTypeWhere(q.betType) : null;
  if (bet) and.push(bet);
  return {
    userId,
    ...(q.capperId ? { capperId: q.capperId } : {}),
    ...(q.sportId ? { sportId: q.sportId } : {}),
    ...(q.status ? { status: q.status as PickStatus } : {}),
    AND: and,
  };
}

export type OlderPicksPage = {
  picks: Awaited<ReturnType<typeof readPage>>;
  cursor: OlderPicksCursor | null;
  hasMore: boolean;
  pagesRead: number;
};

function readPage(userId: string, q: OlderPicksQuery, cutoff: Date, cursor: OlderPicksCursor | null) {
  return prisma.pick.findMany({
    where: olderPicksWhere(userId, q, cutoff, cursor),
    select: FILTERED_PICK_SELECT,
    orderBy: [{ gameTime: "desc" }, { id: "desc" }],
    take: OLDER_PICKS_PAGE_SIZE + 1,
  });
}

// One click. Without a bet-type filter that is one page. With one, the page is
// cut in memory and, while fewer than OLDER_PICKS_MIN_VISIBLE rows survive,
// the next page is read too - at most OLDER_PICKS_MAX_PAGES_PER_CLICK pages.
// The cursor always follows the last row READ, so a cut row is never re-read
// and an uncut row never skipped. A bet-type key no pick can have reads nothing.
export async function getOlderPicks(userId: string, q: OlderPicksQuery, cursor: OlderPicksCursor | null, now: Date): Promise<OlderPicksPage> {
  if (q.betType && !betTypeWhere(q.betType)) return { picks: [], cursor: null, hasMore: false, pagesRead: 0 };
  const cutoff = olderPicksCutoff(q.before, now);
  const visible: OlderPicksPage["picks"] = [];
  let at = cursor;
  let hasMore = true;
  let pagesRead = 0;
  while (hasMore && pagesRead < OLDER_PICKS_MAX_PAGES_PER_CLICK) {
    const rows = await readPage(userId, q, cutoff, at);
    pagesRead++;
    hasMore = rows.length > OLDER_PICKS_PAGE_SIZE;
    const page = rows.slice(0, OLDER_PICKS_PAGE_SIZE);
    const last = page[page.length - 1];
    if (last) at = { gameTime: last.gameTime.toISOString(), id: last.id };
    visible.push(...(q.betType ? page.filter((p) => betTypeFilterCategory(p) === q.betType) : page));
    if (!q.betType || visible.length >= OLDER_PICKS_MIN_VISIBLE) break;
  }
  return { picks: visible, cursor: hasMore ? at : null, hasMore, pagesRead };
}

// Ledger rows for older picks, built like the first page's (toLedgerRow) from
// reads that follow these rows only: names by id (not the roster and sports
// lists), all-time W-L for cappers the client doesn't have yet, final scores
// around each pick's own day, and the live feed (a shared cache, no DB) for
// ungraded picks recent enough to still be in progress. No consensus pills.
export async function buildOlderLedgerRows(
  userId: string,
  picks: OlderPicksPage["picks"],
  knownCapperIds: string[],
  now: Date
): Promise<{ rows: LedgerRow[]; capperRecords: Record<string, string> }> {
  if (picks.length === 0) return { rows: [], capperRecords: {} };
  const named: LedgerSourcePick[] = await withCapperAndSportNames(picks, [], []);
  const known = new Set(knownCapperIds);
  const newCapperIds = Array.from(new Set(named.map((p) => p.capperId))).filter((id) => !known.has(id));
  const [capperRecords, finalScores] = await Promise.all([
    getCapperAllTimeRecords(userId, newCapperIds),
    getFinalScoresForPicks(
      named.map((p) => ({
        id: p.id,
        sportName: p.sport.name,
        status: p.status,
        gameTime: p.gameTime,
        homeTeam: p.homeTeam,
        awayTeam: p.awayTeam,
        betDetail: p.betDetail,
        gameNumber: p.gameNumber,
      })),
      now,
      { span: "pickDays" }
    ),
  ]);
  const feedStatuses = await getFeedStatusesForPicks(
    named
      .filter((p) => p.status === "PENDING" && !finalScores.has(p.id) && now.getTime() - p.gameTime.getTime() <= LIVE_WINDOW_MS)
      .map((p) => ({ id: p.id, sportName: p.sport.name, homeTeam: p.homeTeam, awayTeam: p.awayTeam, gameTime: p.gameTime })),
    now
  );
  const rows = named.map((p) =>
    toLedgerRow(toLedgerPick(p, { now, finalScores, feedStatuses }), { capperRecords, finalScores, feedStatuses, consensus: null, consensusHref: null })
  );
  return {
    rows,
    capperRecords: Object.fromEntries(Array.from(capperRecords, ([id, r]) => [id, r.wins + "-" + r.losses])),
  };
}

// One older row again, after the row menu changed its result: by id, inside
// the user's own picks. null when it is gone.
export async function reloadOlderLedgerRow(userId: string, pickId: string, now: Date): Promise<{ row: LedgerRow; capperRecord: string | null } | null> {
  const pick = await prisma.pick.findFirst({ where: { id: pickId, userId }, select: FILTERED_PICK_SELECT });
  if (!pick) return null;
  const { rows, capperRecords } = await buildOlderLedgerRows(userId, [pick], [], now);
  return { row: rows[0], capperRecord: capperRecords[pick.capperId] ?? null };
}
