// "Load older picks" on /picks (loadOlderPicksAction, server/data/picks-older.ts),
// end to end on the real database:
//
//  1. Paging: clicks walk every older row once, newest first, in the Settled
//     order (gameTime DESC, id DESC) - no gaps and no duplicates across a
//     page boundary that falls mid-day and inside a run of tied gameTimes. Rows
//     in the page's window, after it, and another user's rows never appear.
//     The merged list groups into one header per day.
//  2. Filters apply on every later page too: capper + status, sport, and the
//     in-memory bet-type cut.
//  3. Sparse bet-type filter: a click reads at most 3 pages (~150 rows), and
//     one that finds nothing still returns the cursor and hasMore; the next
//     click carries on from there.
//  4. Final scores for a page with a multi-week gap read +-2 days around each
//     pick's own game, not the span: a game in the gap is never read.
//  5. Validation: malformed filters or cursors are refused; userId is the
//     session's, so another user's capper id matches nothing.
//  6. Every statement a click sends is bounded: the picks read has a LIMIT.
//
// DB-backed and WRITING: a seeded user (cascades to cappers and picks), seeded
// game_results deleted by id. Refuses to run unless DATABASE_URL is local.
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/actions/older-picks-acceptance-test.ts
import { PrismaClient, type Prisma } from "@prisma/client";
import { normalizeSql } from "@/lib/db-monitor";

const queries: string[] = [];
const logged = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
logged.$on("query", (e) => queries.push(e.query));
(globalThis as unknown as { prisma: PrismaClient }).prisma = logged;

let userId = "";
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../auth", { requireUser: async () => ({ id: userId }) });

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}

const TAG = `olp-${Date.now()}`;
const H = 3_600_000;
const WINDOW_DAY = "2023-06-20"; // the page's window: this day only

async function main() {
  if (!["localhost", "127.0.0.1"].includes(hostOf(process.env.DATABASE_URL))) {
    throw new Error("Refusing to run: DATABASE_URL is not local.");
  }
  const { easternDayStart } = await import("@/lib/dates");
  const { groupByDay, OLDER_PICKS_PAGE_SIZE } = await import("@/lib/older-picks");
  const { loadOlderPicksAction } = await import("@/server/actions/picks");
  type Ok = Extract<Awaited<ReturnType<typeof loadOlderPicksAction>>, { success: true }>;
  const prisma = logged;

  const user = await prisma.user.create({ data: { supabaseId: `${TAG}-u`, email: `${TAG}@example.test` } });
  const other = await prisma.user.create({ data: { supabaseId: `${TAG}-o`, email: `${TAG}-o@example.test` } });
  userId = user.id;
  const gameResultIds: string[] = [];
  const createdSportIds: string[] = [];
  // CI's seed has no sports: create one when missing, and delete only what was created.
  const sportNamed = async (name: string) => {
    const existing = await prisma.sport.findUnique({ where: { name }, select: { id: true } });
    if (existing) return existing;
    const created = await prisma.sport.create({ data: { name }, select: { id: true } });
    createdSportIds.push(created.id);
    return created;
  };
  try {
    const mlb = await sportNamed("MLB");
    const nhl = await sportNamed("NHL");
    const capA = await prisma.capper.create({ data: { userId, name: "Alpha", source: "OTHER" } });
    const capB = await prisma.capper.create({ data: { userId, name: "Beta", source: "OTHER" } });
    const foreignCap = await prisma.capper.create({ data: { userId: other.id, name: "Foreign", source: "OTHER" } });

    const at = (dayKey: string, h: number) => new Date(easternDayStart(dayKey).getTime() + h * H);
    const dayKeyBefore = (n: number) => new Date(Date.UTC(2023, 5, 20 - n)).toISOString().slice(0, 10);
    const base = { userId, odds: -110, units: 1, homeTeam: "Home", awayTeam: "Away" };

    // 1-2. 520 older rows over 40 days, 13 a day, in runs of 4 tied gameTimes
    // (4 picks on one game), with cappers / sports / results / bet types mixed
    // independently so every filter below still spans several clicks. Row 50
    // falls mid-day and inside a tie (rows 49 and 50 share a gameTime).
    const older: Prisma.PickCreateManyInput[] = [];
    for (let d = 1; d <= 40; d++) {
      for (let i = 0; i < 13; i++) {
        const n = older.length;
        older.push({
          ...base,
          capperId: n % 2 ? capA.id : capB.id,
          sportId: n % 3 ? mlb.id : nhl.id,
          betType: n % 5 === 0 ? "TOTAL" : "MONEYLINE",
          betDetail: n % 5 === 0 ? "Over 8.5" : "Home ML",
          line: n % 5 === 0 ? 8.5 : null,
          status: (["WIN", "LOSS", "PUSH", "PENDING"] as const)[Math.floor(n / 2) % 4],
          gameTime: at(dayKeyBefore(d), 12 + Math.floor(i / 4)),
        });
      }
    }
    await prisma.pick.createMany({ data: older });
    // The window's own rows, a later day, and another user's older row.
    await prisma.pick.createMany({
      data: [
        { ...base, capperId: capA.id, sportId: mlb.id, betType: "MONEYLINE", status: "WIN", gameTime: at(WINDOW_DAY, 0) },
        { ...base, capperId: capA.id, sportId: mlb.id, betType: "MONEYLINE", status: "WIN", gameTime: at(WINDOW_DAY, 20) },
        { ...base, capperId: capA.id, sportId: mlb.id, betType: "MONEYLINE", status: "WIN", gameTime: at("2023-06-22", 13) },
        { ...base, userId: other.id, capperId: foreignCap.id, sportId: mlb.id, betType: "MONEYLINE", status: "WIN", gameTime: at(dayKeyBefore(2), 13) },
      ],
    });

    // The reference: every older row of this user, in the Settled order, read whole (test only).
    const reference = async (where: Prisma.PickWhereInput = {}) =>
      (
        await prisma.pick.findMany({
          where: { userId, gameTime: { lt: easternDayStart(WINDOW_DAY) }, ...where },
          orderBy: [{ gameTime: "desc" }, { id: "desc" }],
          select: { id: true },
        })
      ).map((r) => r.id);

    // Between scenarios: this user's seeded picks, by exact id.
    async function clearPicks() {
      const ids = (await prisma.pick.findMany({ where: { userId }, select: { id: true } })).map((r) => r.id);
      await prisma.pick.deleteMany({ where: { id: { in: ids }, userId } });
    }

    async function walk(query: Record<string, string>, maxClicks = 20) {
      const ids: string[] = [];
      const rows: Ok["rows"] = [];
      const clicks: Ok[] = [];
      let cursor: Ok["cursor"] = null;
      for (let i = 0; i < maxClicks; i++) {
        const res = await loadOlderPicksAction({ ...query, before: WINDOW_DAY }, cursor, []);
        if (!res.success) throw new Error("click failed: " + res.error);
        clicks.push(res);
        rows.push(...res.rows);
        ids.push(...res.rows.map((r) => r.id));
        cursor = res.cursor;
        if (!res.hasMore) break;
      }
      return { ids, rows, clicks };
    }

    // 1
    queries.length = 0;
    const all = await walk({});
    const want = await reference();
    check("520 older rows: 10 clicks of 50, then 20", JSON.stringify(all.clicks.map((c) => c.rows.length)) === JSON.stringify([...Array(10).fill(50), 20]), JSON.stringify(all.clicks.map((c) => c.rows.length)));
    check("every older row exactly once, in gameTime DESC, id DESC order", JSON.stringify(all.ids) === JSON.stringify(want), `got ${all.ids.length}, want ${want.length}`);
    check("no duplicates across clicks", new Set(all.ids).size === all.ids.length);
    check("the first page boundary falls inside a run of tied gameTimes (mid-day)", all.rows[OLDER_PICKS_PAGE_SIZE - 1].gameTimeIso === all.rows[OLDER_PICKS_PAGE_SIZE].gameTimeIso);
    check("hasMore is false only on the last click", all.clicks.every((c, i) => c.hasMore === (i < all.clicks.length - 1)) && all.clicks[all.clicks.length - 1].cursor === null);
    check("the window's rows, later rows and another user's rows never appear", all.rows.every((r) => new Date(r.gameTimeIso) < easternDayStart(WINDOW_DAY)) && all.ids.length === 520);
    const dayKeyOf = (r: { gameTimeIso: string }) => r.gameTimeIso.slice(0, 10);
    const days = groupByDay(all.rows, dayKeyOf);
    check("the merged list has one header per day", days.length === new Set(all.rows.map(dayKeyOf)).size, String(days.length));
    // A day split across a click boundary, grouped per click, would give that day two headers.
    const perClick = all.clicks.flatMap((c) => groupByDay(c.rows, dayKeyOf));
    check("(per-click grouping would duplicate a header: the test boundary is real)", perClick.length > days.length);
    check("rows carry the row model: capper record for unknown cappers, no consensus", all.rows.every((r) => r.consensus === null && r.capperName.length > 0) &&
      Object.keys(all.clicks[0].capperRecords).length === 2);
    const pickReads = queries.map(normalizeSql).filter((s) => /^SELECT "picks"\."id", "picks"\."capperId"/.test(s));
    check("one picks read per click, each with LIMIT and the cursor ordering", pickReads.length === all.clicks.length && pickReads.every((s) => / LIMIT \$\d+/.test(s) && /ORDER BY "picks"\."gameTime" DESC, "picks"\."id" DESC/.test(s)),
      JSON.stringify(pickReads.map((s) => s.slice(-200))));
    check("later clicks start the scan at the cursor (gameTime <= bound)", pickReads.slice(1).every((s) => /"picks"\."gameTime" <= \$\d+/.test(s)));
    check("no names or roster list reads: names by id only", !queries.some((q) => /ORDER BY "public"\."cappers"\."isFavorite"/.test(q) || /FROM "public"\."leagues"/.test(q)));

    // 2
    for (const [label, query, where] of [
      ["capper + status", { capperId: capA.id, status: "WIN" }, { capperId: capA.id, status: "WIN" }],
      ["sport", { sportId: nhl.id }, { sportId: nhl.id }],
      ["capper + sport", { capperId: capB.id, sportId: mlb.id }, { capperId: capB.id, sportId: mlb.id }],
    ] as [string, Record<string, string>, Prisma.PickWhereInput][]) {
      const got = await walk(query);
      const ref = await reference(where);
      check(`${label}: every matching row once, in order, across ${got.clicks.length} clicks`, got.clicks.length >= 2 && JSON.stringify(got.ids) === JSON.stringify(ref), `got ${got.ids.length} in ${got.clicks.length}, want ${ref.length}`);
      check(`${label}: every row on every click matches`, got.clicks.every((c) => c.rows.every((r) => (!query.capperId || r.capperId === query.capperId) && (!query.status || r.currentStatus === query.status))));
    }
    const totals = await walk({ betType: "TOTAL" });
    const refTotals = await reference({ betType: "TOTAL", period: { not: "FIRST_HALF" } });
    check(`bet type (Total): every matching row once, in order, across ${totals.clicks.length} clicks`, totals.clicks.length >= 2 && JSON.stringify(totals.ids) === JSON.stringify(refTotals) && totals.rows.every((r) => r.tag === "Total" || /total/i.test(r.tag)),
      `got ${totals.ids.length}, want ${refTotals.length}`);
    const notMine = await walk({ capperId: foreignCap.id });
    check("another user's capper id matches nothing", notMine.ids.length === 0 && notMine.clicks.length === 1 && !notMine.clicks[0].hasMore);

    // 3. 200 NRFI-type rows on older days; only the oldest 4 are YRFI.
    await clearPicks();
    const nrfi: Prisma.PickCreateManyInput[] = [];
    for (let n = 0; n < 200; n++) {
      nrfi.push({ ...base, capperId: capA.id, sportId: mlb.id, betType: "NRFI", betDetail: n >= 196 ? "YRFI" : "NRFI", status: "WIN", gameTime: new Date(easternDayStart(WINDOW_DAY).getTime() - (n + 1) * H) });
    }
    await prisma.pick.createMany({ data: nrfi });
    queries.length = 0;
    const first = await loadOlderPicksAction({ betType: "YRFI", before: WINDOW_DAY }, null, []);
    const firstReads = queries.filter((q) => /FROM "public"\."picks"/.test(q) && /LIMIT/.test(q)).length;
    check("sparse filter: one click reads 3 pages and stops", first.success && firstReads === 3, String(firstReads));
    check("sparse filter: 0 visible rows, but the cursor and hasMore come back", first.success && first.rows.length === 0 && first.hasMore && first.cursor !== null);
    queries.length = 0;
    const second = first.success ? await loadOlderPicksAction({ betType: "YRFI", before: WINDOW_DAY }, first.cursor, []) : null;
    const secondReads = queries.filter((q) => /FROM "public"\."picks"/.test(q) && /LIMIT/.test(q)).length;
    check("sparse filter: the next click carries on and finds the 4 YRFI rows", !!second?.success && second.rows.length === 4 && !second.hasMore && secondReads === 1,
      JSON.stringify({ rows: second?.success && second.rows.length, reads: secondReads }));
    const dense = await loadOlderPicksAction({ betType: "NRFI", before: WINDOW_DAY }, null, []);
    check("a filter that leaves 10+ rows on page 1 reads one page", dense.success && dense.rows.length === 50 && dense.hasMore);

    // 4. One page, two picks four weeks apart; a game in the gap must not be read.
    await clearPicks();
    const early = at("2023-05-01", 19);
    const late = at("2023-05-29", 19);
    const teams = { early: ["Seattle Mariners", "Oakland Athletics"], late: ["Detroit Tigers", "Kansas City Royals"], gap: ["Miami Marlins", "Atlanta Braves"] };
    await prisma.pick.createMany({
      data: [
        { ...base, capperId: capA.id, sportId: mlb.id, betType: "MONEYLINE", homeTeam: teams.early[0], awayTeam: teams.early[1], status: "WIN", gameTime: early },
        { ...base, capperId: capA.id, sportId: mlb.id, betType: "MONEYLINE", homeTeam: teams.late[0], awayTeam: teams.late[1], status: "LOSS", gameTime: late },
      ],
    });
    for (const [k, [home, away], when, hs, as] of [
      ["early", teams.early, early, 5, 2],
      ["late", teams.late, late, 1, 7],
      ["gap", teams.gap, at("2023-05-15", 19), 3, 3],
    ] as const) {
      const g = await prisma.gameResult.create({ data: { sportKey: "baseball_mlb", externalId: `${TAG}-${k}`, homeTeam: home, awayTeam: away, homeScore: hs, awayScore: as, gameDate: when } });
      gameResultIds.push(g.id);
    }
    queries.length = 0;
    const gapPage = await loadOlderPicksAction({ before: WINDOW_DAY }, null, []);
    const grRead = queries.filter((q) => /FROM "public"\."game_results"/.test(q));
    check("final scores: one game_results read with a window per pick day", grRead.length === 1 && (grRead[0].match(/"gameDate" >= /g) ?? []).length === 2, grRead.join(" | "));
    const gapRows = await prisma.gameResult.count({
      where: {
        sportKey: "baseball_mlb",
        externalId: { startsWith: TAG },
        OR: [
          { gameDate: { gte: new Date(early.getTime() - 2 * 24 * H), lt: new Date(early.getTime() + 2 * 24 * H) } },
          { gameDate: { gte: new Date(late.getTime() - 2 * 24 * H), lt: new Date(late.getTime() + 2 * 24 * H) } },
        ],
      },
    });
    check("final scores: the windows hold the two games and not the one in the gap", gapRows === 2);
    check("final scores: both picks show their final", gapPage.success && gapPage.rows.length === 2 && gapPage.rows.every((r) => /\(Final\)$/.test(r.matchup)),
      JSON.stringify(gapPage.success && gapPage.rows.map((r) => r.matchup)));

    // 5
    const refused = await Promise.all([
      loadOlderPicksAction({ before: "2023-6-20" }, null, []),
      loadOlderPicksAction({ before: WINDOW_DAY, capperId: "x' OR 1=1 --" }, null, []),
      loadOlderPicksAction({ before: WINDOW_DAY, status: "WON" }, null, []),
      loadOlderPicksAction({ before: WINDOW_DAY, userId: other.id }, null, []),
      loadOlderPicksAction({ capperId: capA.id }, null, []),
      loadOlderPicksAction({ before: WINDOW_DAY }, { gameTime: "yesterday", id: "abc" }, []),
      loadOlderPicksAction({ before: WINDOW_DAY }, { gameTime: new Date().toISOString(), id: "a b" }, []),
    ]);
    check("malformed date, capper id, status, unknown field, missing window, bad cursor: all refused", refused.every((r) => !r.success), JSON.stringify(refused.map((r) => r.success)));
    const unknownBet = await loadOlderPicksAction({ before: WINDOW_DAY, betType: "NOT_A_MARKET" }, null, []);
    check("a bet-type key no pick can have reads nothing", unknownBet.success && unknownBet.rows.length === 0 && !unknownBet.hasMore);
  } finally {
    await prisma.gameResult.deleteMany({ where: { id: { in: gameResultIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
    await prisma.sport.deleteMany({ where: { id: { in: createdSportIds } } });
  }
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(async () => {
    await logged.$disconnect();
    process.exit(failures ? 1 : 0);
  });
