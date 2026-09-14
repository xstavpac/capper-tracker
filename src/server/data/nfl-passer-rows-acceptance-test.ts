// Proof for the two-layer NFL passing pipeline in nfl-passer-rows.ts:
//
//   1. extractPasserRows: faithful ESPN parsing, no QB selection applied -
//      every passer row ESPN reports comes back, including a team's second
//      (mop-up / trick-play) passer.
//   2. persistNflPasserRows: writes every extracted row, unfiltered - proves
//      the persistence layer never uses selectQbPasserRow to decide what to
//      keep (the architectural boundary the two layers are split on).
//   3. selectQbPasserRow: the one place "which row is the QB" gets decided,
//      covering the 7 required scenarios (normal, mop-up backup, meaningful
//      backup, injury replacement, gadget passer, equal-attempt tie-break,
//      empty input).
//
// Reuses the same real, unmodified Week 1 2026 box-score fixtures as
// nfl-passing-stats-acceptance-test.ts (see that file's header for what
// each game covers) - extraction here reads them directly as parsed JSON,
// no fetch stub needed since extractPasserRows takes an already-parsed
// response.
//
// Pure except for the persist section, which stubs prisma.nflPasserRow -
// listed in PURE_DESPITE_PRISMA_IMPORT in scripts/run-tests.mjs. Run with:
//   npx tsx src/server/data/nfl-passer-rows-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { extractPasserRows, persistNflPasserRows, selectQbPasserRow, type PasserRow } from "@/server/data/nfl-passer-rows";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
function ok(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

const FIX = join(__dirname, "__fixtures__");
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf8"));
}
function find(rows: PasserRow[], name: string): PasserRow | undefined {
  return rows.find((r) => r.playerName === name);
}

// Minimal PasserRow builder for the synthetic selectQbPasserRow scenarios -
// only playerName/attempts/passingYards matter to selection, but the full
// shape keeps these interchangeable with real extracted rows.
function row(playerName: string, attempts: number, passingYards: number): PasserRow {
  return {
    externalId: "synthetic-event",
    team: "Synthetic Team",
    espnPlayerId: null,
    playerName,
    completions: Math.min(attempts, Math.round(attempts * 0.65)),
    attempts,
    passingYards,
    yardsPerAttempt: attempts > 0 ? passingYards / attempts : 0,
    touchdowns: 0,
    interceptions: 0,
    sacks: 0,
    sackYardsLost: 0,
    qbr: null,
    rating: 0,
  };
}

async function main() {
  // =====================================================================
  // 1. extractPasserRows: faithful parsing against real fixtures
  // =====================================================================

  // HOU @ BUF (401872660) - one passer per team, exact field-by-field check
  // against ESPN's real final stat line (not just TD/YDS/C-ATT like the
  // sibling getNflPlayerTdStats test - every field this layer adds too).
  const houBuf = extractPasserRows("401872660", loadFixture("nfl-boxscore-401872660-hou-buf.json"));
  ok("HOU@BUF: exactly 2 passer rows (one per team)", houBuf.length === 2, houBuf.length);

  const allen = find(houBuf, "Josh Allen");
  expect("Josh Allen (BUF): full extracted row", allen, {
    externalId: "401872660",
    team: "Buffalo Bills",
    espnPlayerId: "3918298",
    playerName: "Josh Allen",
    completions: 20,
    attempts: 29,
    passingYards: 334,
    yardsPerAttempt: 11.5,
    touchdowns: 2,
    interceptions: 0,
    sacks: 2,
    sackYardsLost: 11,
    qbr: 84.5,
    rating: 130.5,
  });

  const stroud = find(houBuf, "C.J. Stroud");
  expect("C.J. Stroud (HOU): full extracted row", stroud, {
    externalId: "401872660",
    team: "Houston Texans",
    espnPlayerId: "4432577",
    playerName: "C.J. Stroud",
    completions: 26,
    attempts: 38,
    passingYards: 274,
    yardsPerAttempt: 7.2,
    touchdowns: 2,
    interceptions: 0,
    sacks: 3,
    sackYardsLost: 17,
    qbr: 68.3,
    rating: 106.7,
  });

  // PIT @ ATL (401872658) - Pittsburgh has TWO passer rows (Rodgers + a
  // punter's trick-play pass); extraction must keep both, not dedupe/select.
  const pitAtl = extractPasserRows("401872658", loadFixture("nfl-boxscore-401872658-pit-atl.json"));
  ok("PIT@ATL: exactly 3 passer rows (2 for PIT, 1 for ATL) - no dedup/selection", pitAtl.length === 3, pitAtl.length);

  const rodgers = find(pitAtl, "Aaron Rodgers");
  expect("Aaron Rodgers (PIT): completions/attempts/yards/td", {
    c: rodgers?.completions,
    a: rodgers?.attempts,
    y: rodgers?.passingYards,
    td: rodgers?.touchdowns,
  }, { c: 24, a: 40, y: 221, td: 1 });

  const johnston = find(pitAtl, "Cameron Johnston");
  ok("Cameron Johnston (PIT punter, trick-play pass) is present as its own row", !!johnston, johnston);
  expect("Cameron Johnston: attempts/yards + qbr parses '--' as null (not NaN/0)", {
    a: johnston?.attempts,
    y: johnston?.passingYards,
    qbr: johnston?.qbr,
    rating: johnston?.rating,
  }, { a: 1, y: 0, qbr: null, rating: 39.6 });

  const rush = find(pitAtl, "Cooper Rush");
  expect("Cooper Rush (ATL): completions/attempts/int", { c: rush?.completions, a: rush?.attempts, int: rush?.interceptions }, {
    c: 12,
    a: 22,
    int: 2,
  });

  // =====================================================================
  // 2. persistNflPasserRows: writes every row, unfiltered - proves the
  //    persistence layer never applies QB selection to decide what to keep.
  // =====================================================================
  const upsertCalls: any[] = [];
  const originalUpsert = (prisma as any).nflPasserRow?.upsert;
  (prisma as any).nflPasserRow = {
    upsert: async (args: any) => {
      upsertCalls.push(args);
      return args.create;
    },
  };

  const written = await persistNflPasserRows(pitAtl);
  expect("persistNflPasserRows: returns count of every extracted row (3), not just the selected QB", written, 3);
  ok(
    "persistNflPasserRows: Cameron Johnston (the non-selected passer) IS written, not dropped",
    upsertCalls.some((c) => c.create.playerName === "Cameron Johnston")
  );
  ok(
    "persistNflPasserRows: upserts are keyed on (externalId, team, playerName)",
    upsertCalls.every((c) => "externalId_team_playerName" in c.where)
  );

  if (originalUpsert) (prisma as any).nflPasserRow.upsert = originalUpsert;

  const zeroWritten = await persistNflPasserRows([]);
  expect("persistNflPasserRows([]): writes nothing, returns 0", zeroWritten, 0);

  // =====================================================================
  // 3. selectQbPasserRow: the 7 required scenarios
  // =====================================================================

  // 3a. Normal single passer
  expect("1) normal single passer -> that passer", selectQbPasserRow([row("QB A", 29, 250)])?.playerName, "QB A");

  // 3b. Starter + mop-up backup
  expect(
    "2) starter (34 att) + mop-up backup (3 att) -> starter",
    selectQbPasserRow([row("QB A", 34, 300), row("QB B", 3, 20)])?.playerName,
    "QB A"
  );

  // 3c. Starter + meaningful backup (still just highest attempts, no threshold)
  expect(
    "3) starter (22 att) + meaningful backup (8 att) -> starter, no threshold applied",
    selectQbPasserRow([row("QB A", 22, 210), row("QB B", 8, 90)])?.playerName,
    "QB A"
  );
  // Real-data equivalent: MIN @ GB, Wentz (19 att) over Murray (5 att).
  const minGb = extractPasserRows("401872927", loadFixture("nfl-boxscore-401872927-min-gb.json"));
  ok("MIN@GB: exactly 3 passer rows (2 for MIN, 1 for GB)", minGb.length === 3, minGb.length);
  expect(
    "real data: MIN@GB selectQbPasserRow picks Wentz (19 att) over Murray (5 att)",
    selectQbPasserRow(minGb.filter((r) => r.team === "Minnesota Vikings"))?.playerName,
    "Carson Wentz"
  );

  // 3d. Injury replacement - policy is attempts-based, not presumed-starter-based
  expect(
    "4) injury replacement: QB A (11 att) + QB B (24 att) -> QB B, the actual passer",
    selectQbPasserRow([row("QB A", 11, 100), row("QB B", 24, 260)])?.playerName,
    "QB B"
  );

  // 3e. Gadget/trick-play passer
  expect(
    "5) starter (31 att) + gadget/trick-play passer (1 att) -> starter",
    selectQbPasserRow([row("QB A", 31, 280), row("WR/QB B", 1, 15)])?.playerName,
    "QB A"
  );
  // Real-data equivalent: PIT @ ATL, Rodgers (40 att) over Johnston, a punter
  // throwing a trick-play pass (1 att).
  expect(
    "real data: PIT@ATL selectQbPasserRow picks Rodgers (40 att) over Johnston, punter trick-play pass (1 att)",
    selectQbPasserRow(pitAtl.filter((r) => r.team === "Pittsburgh Steelers"))?.playerName,
    "Aaron Rodgers"
  );

  // 3f. Equal-attempt edge case: documented tie-break chain.
  // First tie-break level: same attempts, different passingYards -> more
  // yards wins.
  expect(
    "6a) equal attempts (20 vs 20), different yards -> higher-yardage row wins",
    selectQbPasserRow([row("QB Low Yards", 20, 150), row("QB High Yards", 20, 220)])?.playerName,
    "QB High Yards"
  );
  // Second tie-break level: same attempts AND same yards -> alphabetical by
  // playerName, independent of input array order.
  expect(
    "6b) equal attempts AND equal yards -> alphabetical tie-break (order 1)",
    selectQbPasserRow([row("Zeke Quarterback", 15, 120), row("Alan Quarterback", 15, 120)])?.playerName,
    "Alan Quarterback"
  );
  expect(
    "6b) same tie, input order reversed -> same deterministic winner (not input-order dependent)",
    selectQbPasserRow([row("Alan Quarterback", 15, 120), row("Zeke Quarterback", 15, 120)])?.playerName,
    "Alan Quarterback"
  );

  // 3g. Empty input - explicit "no result" (undefined), same convention as
  // findAggregateSplit(undefined) in mlb-pitcher-history.ts, not a thrown
  // error or an arbitrary fallback row.
  expect("7) selectQbPasserRow([]) -> undefined", selectQbPasserRow([]), undefined);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
