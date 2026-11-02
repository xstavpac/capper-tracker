// The scoring module's data layer, WITHOUT a database: a fake client stands in for prisma, records the statement
// and answers with canned totals.
//   A. includePricing off: the record bundle's statement is byte for byte what it was before pricing existed (the
//      hash is of main at c36c80c), and its result carries no priced fields. Every existing caller is off.
//   B. includePricing on: still ONE statement with the same DB Monitor fingerprint; cards and prop records carry
//      their priced picks; a prop's all-time sums its sport family.
//   C. The platform rollup's statement: one statement, the DB Monitor's label, no pick read back.
//   D. The backtest file is one read-only statement returning aggregates only, and agrees with the code it mirrors.
// Pure - no DB. The real-database half is scoring-data-db-acceptance-test.ts. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/data/scoring-data-acceptance-test.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const PARAMS = { userId: "U", capperIds: ["A", "B"], cardReq: [{ capperId: "A", leagueSport: "NBA", category: "FAV_ML" }], catReq: [{ capperId: "A", category: "FAV_ML" }], propReq: [{ capperId: "A", propMarket: "POINTS" }], asOf: new Date("2026-11-02T00:00:00Z"), last20Window: 20 };

async function main() {
  const { buildBundleQuery } = await import("@/server/data/picks-by-capper-aggregates");
  const { getCapperRecordBundle } = await import("@/server/data/picks");
  const { buildPlatformRatesRecompute } = await import("@/server/data/platform-category-rates");
  const { realBreakEvenSql } = await import("@/server/data/real-price-sql");
  const { PROP_MARKET_KEYS } = await import("@/lib/prop-market-key");

  // ---- A. Off is exactly what it was -----------------------------------------------------
  const off = buildBundleQuery(PARAMS);
  check("off: the statement's text hash is main's", createHash("sha256").update(flat(off.text)).digest("hex"), "19dfe2bcc9c1a0e2af9722901fef2477be8d8e539c647a2465addab4d47ca5f1");
  check("off: its values are main's", off.values.length, 13);
  check("explicit false is the same statement", buildBundleQuery({ ...PARAMS, includePricing: false }).text === off.text, true);

  const TOTALS: CapperRecordBundleTotals = {
    cards: [{ cid: "A", sport: "NBA", cat: "FAV_ML", oWins: 30, oLosses: 20, oPushes: 1, lWins: 12, lLosses: 9, lPushes: 0 }],
    catrec: [],
    streaks: [],
    last20: [],
    propRec: [{ cid: "A", sport: "NBA", mkt: "POINTS", wins: 5, losses: 4, pushes: 0 }],
  };
  answer = TOTALS;
  const req = { leagueEntries: [{ capperId: "A", leagueSport: "NBA", category: "FAV_ML" as const }], categoryPairs: [], propMarketEntries: [{ capperId: "A", leagueSport: "NBA", propMarketKey: "BASKETBALL:POINTS" as const }] };
  const plain = await getCapperRecordBundle("U", req);
  check("off: a card has no priced field", "priced" in plain.leagueRecords.records["A|NBA|FAV_ML"]!, false);
  check("off: a prop record has no priced field", "priced" in plain.propMarketRecords["A|NBA|BASKETBALL:POINTS"]!, false);

  // ---- B. On -----------------------------------------------------------------------------
  const on = buildBundleQuery({ ...PARAMS, includePricing: true });
  check("on: still opens WITH base AS MATERIALIZED and names cardReq (DB Monitor label)", [/^\s*WITH\s+base AS MATERIALIZED \(/.test(on.text), on.text.includes('"cardReq"')], [true, true]);
  check("on: the same bound values", on.values.length, off.values.length);
  check("on: the price rule is the one shared CASE", flat(on.text).includes(flat(realBreakEvenSql("p"))), true);
  check("on: priced columns on cards and prop rows", ['"oPW"', '"oImp"', '"lPW"', '"lImp"', '"pW"', "AS imp"].every((c) => on.text.includes(c)), true);

  sent.length = 0;
  answer = {
    ...TOTALS,
    cards: [{ ...TOTALS.cards[0], oPW: 25, oPL: 15, oImp: 21.5, lPW: 10, lPL: 8, lImp: 9.75 }],
    propRec: [
      { cid: "A", sport: "NBA", mkt: "POINTS", wins: 5, losses: 4, pushes: 0, pW: 4, pL: 3, imp: 3.5 },
      { cid: "A", sport: "WNBA", mkt: "POINTS", wins: 2, losses: 1, pushes: 0, pW: 2, pL: 0, imp: 1 },
      { cid: "A", sport: "NHL", mkt: "POINTS", wins: 9, losses: 9, pushes: 0, pW: 9, pL: 9, imp: 9 },
    ],
  };
  const priced = await getCapperRecordBundle("U", { ...req, includePricing: true });
  check("on: one statement", sent.length, 1);
  check("on: the card's priced picks", priced.leagueRecords.records["A|NBA|FAV_ML"]!.priced, { overall: { wins: 25, losses: 15, impliedSum: 21.5 }, league: { wins: 10, losses: 8, impliedSum: 9.75 } });
  check("on: a prop's all-time sums its family, never another sport's", priced.propMarketRecords["A|NBA|BASKETBALL:POINTS"]!.priced, { league: { wins: 4, losses: 3, impliedSum: 3.5 }, allTime: { wins: 6, losses: 3, impliedSum: 4.5 } });

  // ---- C. The rollup's statement ------------------------------------------------------------
  const rollup = buildPlatformRatesRecompute();
  check("rollup: fingerprint the DB Monitor labels", /^WITH market_keys\(/.test(rollup.text.trim()), true);
  check("rollup: decided picks only, with the shared price rule", [rollup.text.includes("p.status IN ('WIN', 'LOSS')"), flat(rollup.text).includes(flat(realBreakEvenSql("p")))], [true, true]);
  check("rollup: returns two counts, no rows", /SELECT \(SELECT count\(\*\) FROM up\)::int AS written, \(SELECT count\(\*\) FROM gone\)::int AS removed\s*$/.test(rollup.text), true);
  check("rollup: stale rows go by id", rollup.text.includes("DELETE FROM platform_category_rates WHERE id NOT IN (SELECT id FROM up)"), true);
  check("rollup: no user, capper or pick id in the table's columns", /INSERT INTO platform_category_rates \(id, league, "betType", key, wins, losses, "impliedSum", priced, "computedAt"\)/.test(rollup.text), true);

  // ---- D. The backtest file -----------------------------------------------------------------
  const file = readFileSync(join(process.cwd(), "scripts/t2-harness/scoring-backtest.sql"), "utf8");
  const code = file.replace(/--.*$/gm, "");
  check("backtest: one statement, ending in the only semicolon", [code.split(";").length, code.trim().endsWith(";")], [2, true]);
  check("backtest: starts with WITH, reads only", [/^\s*WITH\b/.test(code), /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|COPY|SET)\b/i.test(code.replace(/"[^"]*"/g, ""))], [true, false]);
  check("backtest: the price rule is the shared CASE", flat(code).includes(flat(realBreakEvenSql("p"))), true);
  const finalPart = file.slice(file.indexOf("-- @@FINAL"));
  const output = finalPart.slice(finalPart.indexOf("\nSELECT 'rank_bucket'"));
  check("backtest: output is aggregates, no id, user, capper or name", /\b(uid|cid|id|name|league)\b/.test(output), false);
  check("backtest: all three variants and both scopes", ["'old_wilson'", "'win_rate_378'", "'edge_logit'", "'EXCL_NHL_MLB'", "'GATED_55'", "price_range_top5"].every((v) => finalPart.includes(v)), true);
  const listed = [...file.matchAll(/\('(FOOTBALL|BASKETBALL|HOCKEY|BASEBALL)','([A-Z_]+)'\)/g)].map((m) => `${m[1]}:${m[2]}`).sort();
  check("backtest: its market list is PROP_MARKET_KEYS", listed, [...PROP_MARKET_KEYS].sort());

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
