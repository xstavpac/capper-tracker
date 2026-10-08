// Pick.oddsSource: where a pick's stored price came from (lib/odds-source.ts).
//
// 1. The three-way decision (resolvePickPrice): STATED / MARKET / DEFAULTED,
//    incl. the cases the stored number alone can't tell apart - a capper's own
//    -110, and a feed price that happens to be -110.
// 2. Bulk-import path: lines parsed by parseCatalog, with and without a price,
//    through that decision.
// 3. Recovery path: lines parseCatalog could not place, recovered by
//    recoverUnresolvedLines, through the same decision. Recovery writes nothing
//    itself - its picks are imported by the bulk resolver like any other line.
// 4. Wiring (text scan of bulk-picks.ts): the resolver's odds and oddsSource
//    both come from the one resolvePickPrice call, and the import row carries
//    oddsSource.
// 5. Real database: each value is stored as given; a row that omits it stays
//    null (the "created before the column" state); the manual createPick path
//    stores STATED.
//
// Run with DATABASE_URL set:
//   npx tsx src/server/data/pick-odds-source-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { resolvePickPrice } from "@/lib/odds-source";
import { parseCatalog } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { createPicksWithEntitlementCheck, type PickInsertData } from "@/server/data/subscriptions";
import { createPick } from "@/server/data/picks";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const TAG = `pos-${Date.now()}`;

// ---- 1. the decision ----

check("price on the line -> STATED", resolvePickPrice({ odds: -135, hasExplicitOdds: true }, null), { odds: -135, oddsSource: "STATED" });
check("no price, feed has one -> MARKET at the feed price", resolvePickPrice({ odds: -110, hasExplicitOdds: false }, -128), { odds: -128, oddsSource: "MARKET" });
check("no price, nothing from the feed -> DEFAULTED at the placeholder", resolvePickPrice({ odds: -110, hasExplicitOdds: false }, null), { odds: -110, oddsSource: "DEFAULTED" });
check("a capper's own -110 is STATED, not DEFAULTED", resolvePickPrice({ odds: -110, hasExplicitOdds: true }, null), { odds: -110, oddsSource: "STATED" });
check("a feed price of exactly -110 is MARKET, not DEFAULTED", resolvePickPrice({ odds: -110, hasExplicitOdds: false }, -110), { odds: -110, oddsSource: "MARKET" });
check("a stated price is never replaced by the feed's", resolvePickPrice({ odds: 145, hasExplicitOdds: true }, 120), { odds: 145, oddsSource: "STATED" });

// ---- 2. bulk-import path ----

{
  const { picks } = parseCatalog("Some Capper\nYankees ML -135\nDodgers ML", ["Some Capper"]);
  const priced = picks.find((p) => p.hasExplicitOdds);
  const bare = picks.find((p) => !p.hasExplicitOdds);
  check("bulk: both lines parsed, one with a price and one without", [picks.length, priced?.odds, bare?.odds], [2, -135, -110]);
  if (priced && bare) {
    check("bulk: priced line -> STATED", resolvePickPrice(priced, null), { odds: -135, oddsSource: "STATED" });
    check("bulk: bare line + feed price -> MARKET", resolvePickPrice(bare, -162), { odds: -162, oddsSource: "MARKET" });
    check("bulk: bare line, no feed price -> DEFAULTED", resolvePickPrice(bare, null), { odds: -110, oddsSource: "DEFAULTED" });
  }
}

// ---- 3. recovery path ----

{
  const roster: RosterPlayer[] = [
    { playerName: "Mike Evans", firstName: "Mike", lastName: "Evans", team: "Tampa Bay Buccaneers", position: "WR", externalPlayerId: "1" },
    { playerName: "Caleb Williams", firstName: "Caleb", lastName: "Williams", team: "Chicago Bears", position: "QB", externalPlayerId: "2" },
  ];
  const { unresolved, unresolvedCapperNames } = parseCatalog(
    "Some Capper\ncaleb williams over 220.5 passing yards\nmike evans over 56.5 rec yards -125",
    ["Some Capper"]
  );
  const { recovered } = recoverUnresolvedLines(unresolved, unresolvedCapperNames, [], roster);
  const priced = recovered.find((p) => p.hasExplicitOdds);
  const bare = recovered.find((p) => !p.hasExplicitOdds);
  check("recovery: both lines needed recovery and were recovered, one priced and one not", [unresolved.length, recovered.length, priced?.odds, bare?.odds], [2, 2, -125, -110]);
  if (priced && bare) {
    check("recovery: priced line -> STATED", resolvePickPrice(priced, null), { odds: -125, oddsSource: "STATED" });
    check("recovery: bare line + feed price -> MARKET", resolvePickPrice(bare, -118), { odds: -118, oddsSource: "MARKET" });
    check("recovery: bare line, no feed price -> DEFAULTED", resolvePickPrice(bare, null), { odds: -110, oddsSource: "DEFAULTED" });
  }
}

// ---- 4. wiring ----

{
  const src = readFileSync(join(process.cwd(), "src/server/actions/bulk-picks.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("async function resolveGameAndOdds(");
  const end = src.indexOf("\nexport async function previewBulkImportOdds");
  const resolver = src.slice(start, end);
  check("wiring: resolveGameAndOdds found", start >= 0 && end > start, true);
  check("wiring: its odds + oddsSource come from one resolvePickPrice(item, feedPrice) call", (resolver.match(/const \{ odds, oddsSource \} = resolvePickPrice\(item, feedPrice\);/g) ?? []).length, 1);
  check("wiring: nothing else in the resolver assigns odds", /(^|[^.\w])odds\s*=[^=]/m.test(resolver.replace("const { odds, oddsSource } = resolvePickPrice(item, feedPrice);", "")), false);
  check("wiring: three feed lookups set feedPrice", (resolver.match(/feedPrice = \w+Price;/g) ?? []).length, 3);
  check("wiring: the import row carries oddsSource", /toInsert\.push\(\{[^}]*\bodds,\n\s*oddsSource,/.test(src), true);
}

// ---- 5. database ----

async function main() {
  const user = await prisma.user.create({ data: { supabaseId: TAG, email: `${TAG}@example.test` } });
  let createdSportId: string | null = null;
  try {
    await prisma.subscription.create({ data: { userId: user.id, plan: "BASIC", status: "active" } });
    const capper = await prisma.capper.create({ data: { userId: user.id, name: "cap-" + TAG, source: "OTHER" } });
    let sport = await prisma.sport.findFirst({ where: { name: "MLB" } });
    if (!sport) {
      sport = await prisma.sport.create({ data: { name: "MLB" } });
      createdSportId = sport.id;
    }
    const base = { capperId: capper.id, sportId: sport.id, homeTeam: "Home", awayTeam: "Away", betType: "MONEYLINE" as const, units: 1, gameTime: new Date("2026-06-01T17:00:00.000Z") };
    const rows: PickInsertData[] = [
      { ...base, betDetail: "stated", odds: -135, oddsSource: "STATED" },
      { ...base, betDetail: "market", odds: -128, oddsSource: "MARKET" },
      { ...base, betDetail: "defaulted", odds: -110, oddsSource: "DEFAULTED" },
      { ...base, betDetail: "omitted", odds: -110 },
    ];
    const res = await createPicksWithEntitlementCheck(user.id, rows);
    check("db: batch insert allowed", res.allowed, true);

    await createPick(user.id, { ...base, betDetail: "manual", odds: -110 });

    const stored = await prisma.pick.findMany({ where: { userId: user.id }, select: { betDetail: true, odds: true, oddsSource: true } });
    const byDetail = stored.map((p) => p.betDetail + ":" + p.oddsSource).sort();
    check("db: each source is stored as given; an omitted one stays null; the manual form stores STATED", byDetail, ["defaulted:DEFAULTED", "manual:STATED", "market:MARKET", "omitted:null", "stated:STATED"]);
    check(
      "db: three -110 picks that look identical by price are told apart",
      stored.filter((p) => p.odds === -110).map((p) => p.betDetail + ":" + p.oddsSource).sort(),
      ["defaulted:DEFAULTED", "manual:STATED", "omitted:null"]
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
    if (createdSportId) await prisma.sport.deleteMany({ where: { id: createdSportId } });
  }
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} assertion(s) failed`);
      process.exit(1);
    }
    console.log("\nAll assertions passed");
  });
