// Proof that getParlaysForUser (the /picks parlay section) returns PENDING parlays of any date plus
// parlays posted in the page's Eastern date range, narrows both by capperId, and that the narrowed
// select still yields exactly the card data the old full include did. Pure: prisma.parlayBet.findMany
// is swapped for an in-memory fake that evaluates the where/select shapes this query uses. Run with:
//   npx tsx src/server/data/parlays-bounded-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { prisma } from "@/lib/prisma";
import { getParlaysForUser, PARLAY_CARD_SELECT } from "@/server/data/parlays";
import { easternDayStart } from "@/lib/dates";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

type Row = Record<string, any>;
const sport = { id: "s1", name: "NBA", extra: "x" };
const league = { id: "l1", name: "NBA", extra: "x" };
const capper = (id: string, name: string) => ({ id, name, photoUrl: "p", notes: "n" });

function parlay(id: string, capperId: string, status: string, datePosted: string): Row {
  return {
    id,
    userId: "u1",
    capperId,
    units: 2,
    status,
    datePosted: new Date(datePosted),
    notes: "n",
    capper: capper(capperId, "Cap " + capperId),
    legs: [
      { id: id + "-b", legIndex: 1, awayTeam: "A2", homeTeam: "H2", period: "FULL_GAME", betDetail: null, betType: "TOTAL", line: 210.5, odds: -110, status, sport, league, sportId: "s1", leagueId: "l1", gameTime: new Date(datePosted) },
      { id: id + "-a", legIndex: 0, awayTeam: "A1", homeTeam: "H1", period: "FIRST_HALF", betDetail: "Over", betType: "MONEYLINE", line: null, odds: 150, status, sport, league, sportId: "s1", leagueId: "l1", gameTime: new Date(datePosted) },
    ],
  };
}

const rows: Row[] = [
  parlay("in-settled", "c1", "WIN", "2026-10-02T18:00:00Z"),
  parlay("out-settled", "c1", "LOSS", "2026-09-01T18:00:00Z"),
  parlay("out-pending", "c1", "PENDING", "2026-08-01T18:00:00Z"),
  parlay("other-capper-pending", "c2", "PENDING", "2026-08-02T18:00:00Z"),
  parlay("other-capper-in", "c2", "WIN", "2026-10-02T19:00:00Z"),
  { ...parlay("other-user", "c1", "PENDING", "2026-10-02T18:00:00Z"), userId: "u2" },
];

function matches(row: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!(v as Row[]).some((w) => matches(row, w))) return false;
    } else if (v && typeof v === "object" && !(v instanceof Date)) {
      const d = row[k] as Date;
      if ("gte" in v && !(d >= v.gte)) return false;
      if ("lt" in v && !(d < v.lt)) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

function project(row: Row, select: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if (k === "orderBy" || v === false) continue;
    if (v === true) out[k] = row[k];
    else if (Array.isArray(row[k])) {
      const arr = [...row[k]];
      if (v.orderBy?.legIndex === "asc") arr.sort((a, b) => a.legIndex - b.legIndex);
      out[k] = arr.map((r) => project(r, v.select));
    } else out[k] = project(row[k], v.select);
  }
  return out;
}

let lastArgs: Row | null = null;
(prisma.parlayBet as unknown as { findMany: (a: Row) => Promise<Row[]> }).findMany = async (args) => {
  lastArgs = args;
  return rows
    .filter((r) => matches(r, args.where))
    .sort((a, b) => b.datePosted.getTime() - a.datePosted.getTime())
    .map((r) => project(r, args.select));
};

const ids = (r: Row[]) => r.map((p) => p.id);
const range = { startDateKey: "2026-10-02", endDateKey: "2026-10-02" };

async function main() {
  const all = await getParlaysForUser("u1", range);
  expect("settled out of range excluded; pending out of range included; in-range included",
    ids(all), ["other-capper-in", "in-settled", "other-capper-pending", "out-pending"]);
  expect("other user's parlays never returned", ids(all).includes("other-user"), false);

  const c1 = await getParlaysForUser("u1", { ...range, capperId: "c1" });
  expect("capper filter narrows both the in-range and the pending sets", ids(c1), ["in-settled", "out-pending"]);

  const multiDay = await getParlaysForUser("u1", { startDateKey: "2026-08-30", endDateKey: "2026-10-02", capperId: "c1" });
  expect("a wider range pulls in the settled parlay it covers", ids(multiDay), ["in-settled", "out-settled", "out-pending"]);

  const unbounded = await getParlaysForUser("u1");
  expect("no date keys = no date bound (all of the user's parlays)", unbounded.length, 5);

  // The in-range window is the Eastern day: [start of 10-02 ET, start of 10-03 ET).
  await getParlaysForUser("u1", range);
  const bounded = (lastArgs as unknown as Row).where.OR[1].datePosted;
  expect("range uses easternDateRange bounds", [bounded.gte.getTime(), bounded.lt.getTime()],
    [easternDayStart("2026-10-02").getTime(), easternDayStart("2026-10-03").getTime()]);

  // Card data: what the JSX reads, from the narrow select vs. projected out of the old full include.
  const CARD_FIELDS = {
    parlay: ["id", "units", "status"],
    leg: ["id", "awayTeam", "homeTeam", "period", "betDetail", "betType", "line", "odds", "status"],
  };
  const card = (p: Row) => ({
    id: p.id, status: p.status, units: p.units, capper: p.capper.name,
    legs: p.legs.map((l: Row) => ({ ...Object.fromEntries(CARD_FIELDS.leg.map((f) => [f, l[f]])), sport: l.sport.name })),
  });
  const oldShape = card(rows[0]); // old include: legs ordered by legIndex asc, full relations
  oldShape.legs = [...rows[0].legs].sort((a, b) => a.legIndex - b.legIndex).map((l: Row) => ({
    ...Object.fromEntries(CARD_FIELDS.leg.map((f) => [f, l[f]])), sport: l.sport.name }));
  const inRange = (await getParlaysForUser("u1", { ...range, capperId: "c1" })).find((p) => p.id === "in-settled")!;
  expect("in-range parlay card data identical to the old include's", card(inRange), oldShape);
  expect("narrow select has no league / full capper / full sport", [
    "league" in (PARLAY_CARD_SELECT.legs.select as Row),
    PARLAY_CARD_SELECT.capper.select,
    PARLAY_CARD_SELECT.legs.select.sport.select,
  ], [false, { name: true }, { name: true }]);

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll assertions passed.");
}
main();
