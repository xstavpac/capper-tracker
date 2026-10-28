// Per-market prop records in the record bundle (getCapperRecordBundle /
// getCapperPropMarketRecords, picks.ts; the propRec CTE in
// picks-by-capper-aggregates.ts), WITHOUT a database: a fake client stands in
// for prisma (globalThis.prisma, which lib/prisma.ts reuses), records the one
// statement sent and answers with canned totals.
//   A. Assembly: in-league is the entry's own sport's row, all-time the sum over
//      the key's sport family - NBA points never pick up NHL points, WNBA counts
//      toward NBA's all-time but not its in-league. No decided pick: null.
//   B. Nothing else moves: cards, catrec, streaks and last20 are identical with
//      and without prop requests, and so is every byte of the statement before
//      the prop CTEs. A caller that sends no prop entries gets {}.
//   C. SQL shape: still ONE statement; it still opens "WITH base AS MATERIALIZED ("
//      and names "cardReq" (the DB Monitor's "Record bundle" label); an empty
//      prop list uses the zero-row SELECT; one (capper, propMarket) pair per
//      market whatever the league; asOf is bound once, only inside propRec.
// Pure - no DB. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/data/prop-market-records-bundle-acceptance-test.ts
import type { Prisma } from "@prisma/client";
import type { CapperRecordBundleTotals } from "@/server/data/picks-by-capper-aggregates";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const sent: Prisma.Sql[] = [];
let answer: CapperRecordBundleTotals;
(globalThis as unknown as { prisma: unknown }).prisma = {
  $queryRaw: async (sql: Prisma.Sql) => {
    sent.push(sql);
    return [{ out: answer }];
  },
};

const TOTALS: CapperRecordBundleTotals = {
  cards: [{ cid: "A", sport: "NBA", cat: "TD_PROP", oWins: 30, oLosses: 20, oPushes: 1, lWins: 12, lLosses: 9, lPushes: 0 }],
  catrec: [{ cid: "A", cat: "TD_PROP", wins: 30, losses: 20, pushes: 1 }],
  streaks: [{ cid: "A", type: "WIN", count: 3 }],
  last20: [{ cid: "A", decided: 51, wins: 11, losses: 9, pushes: 0 }],
  propRec: [
    { cid: "A", sport: "NBA", mkt: "POINTS", wins: 7, losses: 3, pushes: 1 },
    { cid: "A", sport: "WNBA", mkt: "POINTS", wins: 2, losses: 2, pushes: 0 },
    { cid: "A", sport: "NHL", mkt: "POINTS", wins: 9, losses: 1, pushes: 0 },
    { cid: "A", sport: "NHL", mkt: "SHOTS_ON_GOAL", wins: 4, losses: 4, pushes: 0 },
    { cid: "B", sport: "NBA", mkt: "POINTS", wins: 1, losses: 0, pushes: 0 },
  ],
};

async function main() {
  const { getCapperRecordBundle, getCapperPropMarketRecords } = await import("@/server/data/picks");
  const { propMarketRecordKey } = await import("@/lib/record-keys");
  const col = (wins: number, losses: number, pushes: number) => ({ wins, losses, pushes, winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0, count: wins + losses + pushes });

  const base = {
    leagueEntries: [{ capperId: "A", leagueSport: "NBA", category: "TD_PROP" as const }],
    categoryPairs: [{ capperId: "A", category: "TD_PROP" as const }],
  };
  const propMarketEntries = [
    { capperId: "A", leagueSport: "NBA", propMarketKey: "BASKETBALL:POINTS" as const },
    { capperId: "A", leagueSport: "WNBA", propMarketKey: "BASKETBALL:POINTS" as const },
    { capperId: "A", leagueSport: "NHL", propMarketKey: "HOCKEY:POINTS" as const },
    { capperId: "A", leagueSport: "NHL", propMarketKey: "HOCKEY:SAVES" as const },
  ];
  const asOf = new Date("2026-10-28T23:00:00.000Z");

  // ---- A. Assembly
  answer = TOTALS;
  const withProps = await getCapperRecordBundle("U", { ...base, propMarketEntries, asOf });
  const r = withProps.propMarketRecords;
  check("NBA points: in-league NBA only, all-time NBA + WNBA, never NHL", r[propMarketRecordKey("A", "NBA", "BASKETBALL:POINTS")], {
    key: "BASKETBALL:POINTS",
    league: col(7, 3, 1),
    allTime: col(9, 5, 1),
  });
  check("WNBA points: in-league WNBA only, same all-time", r[propMarketRecordKey("A", "WNBA", "BASKETBALL:POINTS")], {
    key: "BASKETBALL:POINTS",
    league: col(2, 2, 0),
    allTime: col(9, 5, 1),
  });
  check("NHL points: hockey only", r[propMarketRecordKey("A", "NHL", "HOCKEY:POINTS")], { key: "HOCKEY:POINTS", league: col(9, 1, 0), allTime: col(9, 1, 0) });
  check("no decided pick on the market: null", r[propMarketRecordKey("A", "NHL", "HOCKEY:SAVES")], null);
  check("another capper's rows never count", Object.values(r).every((x) => x === null || x.allTime.wins !== 10), true);
  check("one output key per entry", Object.keys(r).length, 4);

  const helper = await getCapperPropMarketRecords("U", propMarketEntries.slice(0, 1), { asOf });
  check("getCapperPropMarketRecords: the same record", helper[propMarketRecordKey("A", "NBA", "BASKETBALL:POINTS")], r[propMarketRecordKey("A", "NBA", "BASKETBALL:POINTS")]);

  // ---- B. Nothing else moves
  const withoutProps = await getCapperRecordBundle("U", base);
  check("leagueRecords identical with and without prop entries", withoutProps.leagueRecords, withProps.leagueRecords);
  check("categoryRecords identical with and without prop entries", withoutProps.categoryRecords, withProps.categoryRecords);
  check("no prop entries: no prop records", withoutProps.propMarketRecords, {});

  // ---- C. SQL shape (sent: withProps, helper, withoutProps)
  check("one statement per bundle call", sent.length, 3);
  const [sqlWith, , sqlWithout] = sent;
  check("opens WITH base AS MATERIALIZED (", [sqlWith, sqlWithout].map((s) => /^\s*WITH\s+base AS MATERIALIZED \(/.test(s.text)), [true, true]);
  check("still names \"cardReq\" (DB Monitor label)", [sqlWith, sqlWithout].map((s) => s.text.includes('"cardReq"')), [true, true]);
  const head = (s: Prisma.Sql) => s.text.slice(0, s.text.indexOf('"propReq"'));
  check("every byte before the prop CTEs is the same", head(sqlWith) === head(sqlWithout), true);
  // Without props the only value after the shared ones is asOf.
  const shared = sqlWithout.values.length - 1;
  check("the values before the prop CTEs are the same", JSON.stringify(sqlWith.values.slice(0, shared)), JSON.stringify(sqlWithout.values.slice(0, shared)));
  check("no prop entries: zero-row propReq", /"propReq"\(cid, mkt\) AS \(SELECT NULL::text, NULL::text WHERE FALSE\)/.test(sqlWithout.text), true);
  check(
    "one (capper, propMarket) pair per market whatever the league: A|POINTS, A|SAVES",
    (sqlWith.text.match(/"propReq"\(cid, mkt\) AS \(VALUES ([^)]*\)(?:,\s*\([^)]*\))*)/)?.[1].match(/\(/g) ?? []).length,
    2
  );
  const asOfAt = sqlWith.values.findIndex((v) => v instanceof Date && v.getTime() === asOf.getTime());
  check("asOf bound exactly once", sqlWith.values.filter((v) => v instanceof Date).length, 1);
  const placeholder = `$${asOfAt + 1}`;
  const propRecAt = sqlWith.text.indexOf('"propRec" AS (');
  const selectAt = sqlWith.text.indexOf("SELECT jsonb_build_object(");
  const used = [...sqlWith.text.matchAll(new RegExp(`\\${placeholder}(?!\\d)`, "g"))].map((m) => m.index!);
  check("asOf is used once, inside propRec only", used.length === 1 && used[0] > propRecAt && used[0] < selectAt, true);
  check("propRec counts games before asOf", sqlWith.text.includes(`WHERE b."gameTime" < ${placeholder}`), true);
  const defaultDate = sqlWithout.values.find((v) => v instanceof Date) as Date | undefined;
  check("asOf defaults to now", !!defaultDate && Math.abs(defaultDate.getTime() - Date.now()) < 60_000, true);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
    process.exit(failures > 0 ? 1 : 0);
  });
