// Proof for the NFL rushing/receiving box-score pipeline in
// nfl-rushing-receiving-rows.ts:
//
//   1. extractRushingRows / extractReceivingRows: faithful ESPN parsing,
//      every row ESPN reports comes back unfiltered - including a player
//      who both rushed and caught passes (two separate rows, one per
//      category) and a player with a 0-reception/0-yard receiving row that
//      still had targets.
//   2. persistNflRushingRows / persistNflReceivingRows: write every
//      extracted row, unfiltered - proves the persistence layer applies no
//      selection (there is none to apply - see this file's own header).
//
// Reuses the same real, unmodified Week 1 2026 box-score fixtures as
// nfl-passer-rows-acceptance-test.ts and nfl-passing-stats-acceptance-test.ts
// (see those files' headers for what each game covers) - extraction here
// reads them directly as parsed JSON, no fetch stub needed.
//
// Pure except for the persist section, which stubs
// prisma.nflRushingRow/nflReceivingRow - listed in PURE_DESPITE_PRISMA_IMPORT
// in scripts/run-tests.mjs. Run with:
//   npx tsx src/server/data/nfl-rushing-receiving-rows-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import {
  extractRushingRows,
  extractReceivingRows,
  persistNflRushingRows,
  persistNflReceivingRows,
  type RushingRow,
  type ReceivingRow,
} from "@/server/data/nfl-rushing-receiving-rows";

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
function findRush(rows: RushingRow[], name: string): RushingRow | undefined {
  return rows.find((r) => r.playerName === name);
}
function findRec(rows: ReceivingRow[], name: string): ReceivingRow | undefined {
  return rows.find((r) => r.playerName === name);
}

async function main() {
  // =====================================================================
  // 1. extractRushingRows / extractReceivingRows: faithful parsing against
  //    real fixtures
  // =====================================================================

  // HOU @ BUF (401872660)
  const houBufRushing = extractRushingRows("401872660", loadFixture("nfl-boxscore-401872660-hou-buf.json"));
  const houBufReceiving = extractReceivingRows("401872660", loadFixture("nfl-boxscore-401872660-hou-buf.json"));
  ok("HOU@BUF: 8 rushing rows (4 per team)", houBufRushing.length === 8, houBufRushing.length);
  ok("HOU@BUF: 18 receiving rows (7 BUF + 11 HOU)", houBufReceiving.length === 18, houBufReceiving.length);

  // Real final box score: James Cook III (BUF) - 13 CAR, 57 YDS, 4.4 AVG,
  // 0 TD, 12 LONG rushing; 3 REC, 12 YDS, 4.0 AVG, 0 TD, 6 LONG, 4 TGTS
  // receiving. Confirms a dual-category player produces two independent,
  // fully-populated rows rather than being merged or dropped from either.
  const cookRush = findRush(houBufRushing, "James Cook III");
  expect("James Cook III (BUF): full extracted rushing row", cookRush, {
    externalId: "401872660",
    team: "Buffalo Bills",
    espnPlayerId: "4379399",
    playerName: "James Cook III",
    carries: 13,
    rushingYards: 57,
    yardsPerCarry: 4.4,
    touchdowns: 0,
    long: 12,
  });
  const cookRec = findRec(houBufReceiving, "James Cook III");
  expect("James Cook III (BUF): full extracted receiving row", cookRec, {
    externalId: "401872660",
    team: "Buffalo Bills",
    espnPlayerId: "4379399",
    playerName: "James Cook III",
    receptions: 3,
    receivingYards: 12,
    yardsPerReception: 4.0,
    touchdowns: 0,
    long: 6,
    targets: 4,
  });

  // Real final box score: David Montgomery (HOU) - 20 CAR, 60 YDS, 3.0 AVG,
  // 2 TD, 18 LONG rushing; 3 REC, 19 YDS, 6.3 AVG, 1 TD, 9 LONG, 3 TGTS
  // receiving.
  const montyRush = findRush(houBufRushing, "David Montgomery");
  expect("David Montgomery (HOU): rushing carries/yards/avg/td/long", {
    car: montyRush?.carries,
    yds: montyRush?.rushingYards,
    avg: montyRush?.yardsPerCarry,
    td: montyRush?.touchdowns,
    long: montyRush?.long,
  }, { car: 20, yds: 60, avg: 3.0, td: 2, long: 18 });
  const montyRec = findRec(houBufReceiving, "David Montgomery");
  expect("David Montgomery (HOU): receiving rec/yards/avg/td/long/tgts", {
    rec: montyRec?.receptions,
    yds: montyRec?.receivingYards,
    avg: montyRec?.yardsPerReception,
    td: montyRec?.touchdowns,
    long: montyRec?.long,
    tgts: montyRec?.targets,
  }, { rec: 3, yds: 19, avg: 6.3, td: 1, long: 9, tgts: 3 });

  // PIT @ ATL (401872658) - covers negative rushing yards/long (a QB
  // scramble box, not a receiving stat).
  const pitAtlRushing = extractRushingRows("401872658", loadFixture("nfl-boxscore-401872658-pit-atl.json"));
  const pitAtlReceiving = extractReceivingRows("401872658", loadFixture("nfl-boxscore-401872658-pit-atl.json"));

  const rodgers = findRush(pitAtlRushing, "Aaron Rodgers");
  expect("Aaron Rodgers (PIT): negative rushing yards/long parsed correctly, not 0/NaN", {
    car: rodgers?.carries,
    yds: rodgers?.rushingYards,
    avg: rodgers?.yardsPerCarry,
    long: rodgers?.long,
  }, { car: 3, yds: -3, avg: -1.0, long: -1 });

  // Kyle Pitts Sr. (ATL): 0 REC, 0 YDS, but 1 TGTS - a real "targeted but
  // didn't catch it" row that must still be present with its true zero
  // stats, not filtered out.
  const pitts = findRec(pitAtlReceiving, "Kyle Pitts Sr.");
  ok("Kyle Pitts Sr. (0-reception, 1-target row) is present, not filtered out", !!pitts, pitts);
  expect("Kyle Pitts Sr.: 0 rec/0 yds/1 tgt - real zero-catch row kept intact", {
    rec: pitts?.receptions,
    yds: pitts?.receivingYards,
    tgts: pitts?.targets,
  }, { rec: 0, yds: 0, tgts: 1 });

  // Bijan Robinson (ATL): also rushed and caught a TD - both category rows
  // present and independently correct.
  const bijanRush = findRush(pitAtlRushing, "Bijan Robinson");
  const bijanRec = findRec(pitAtlReceiving, "Bijan Robinson");
  expect("Bijan Robinson: rushing row", { car: bijanRush?.carries, yds: bijanRush?.rushingYards, td: bijanRush?.touchdowns }, {
    car: 21,
    yds: 83,
    td: 0,
  });
  expect(
    "Bijan Robinson: receiving row (same player, different category, different TD count)",
    { rec: bijanRec?.receptions, yds: bijanRec?.receivingYards, td: bijanRec?.touchdowns },
    { rec: 8, yds: 90, td: 1 }
  );

  // MIN @ GB (401872927) - covers multiple 0-rec/0-yds-with-target rows in
  // one team (Chris Brooks, MarShawn Lloyd, Skyy Moore for GB; Aaron Jones
  // Sr., Jauan Jennings, Jordan Addison for MIN), plus a negative-rushing
  // QB kneel-down line (Carson Wentz).
  const minGbRushing = extractRushingRows("401872927", loadFixture("nfl-boxscore-401872927-min-gb.json"));
  const minGbReceiving = extractReceivingRows("401872927", loadFixture("nfl-boxscore-401872927-min-gb.json"));

  const wentzRush = findRush(minGbRushing, "Carson Wentz");
  expect("Carson Wentz (MIN): negative rushing yards from kneel-downs", {
    car: wentzRush?.carries,
    yds: wentzRush?.rushingYards,
    avg: wentzRush?.yardsPerCarry,
  }, { car: 5, yds: -1, avg: -0.2 });

  const addison = findRec(minGbReceiving, "Jordan Addison");
  expect("Jordan Addison (MIN): 0 rec/0 yds but 2 targets - zero-catch row kept, not dropped", {
    rec: addison?.receptions,
    yds: addison?.receivingYards,
    tgts: addison?.targets,
  }, { rec: 0, yds: 0, tgts: 2 });

  const zeroCatchNames = ["Chris Brooks", "MarShawn Lloyd", "Skyy Moore", "Aaron Jones Sr.", "Jauan Jennings", "Jordan Addison"];
  ok(
    "MIN@GB: all 6 known zero-catch/nonzero-target receivers are present",
    zeroCatchNames.every((n) => !!findRec(minGbReceiving, n)),
    zeroCatchNames.filter((n) => !findRec(minGbReceiving, n))
  );

  // =====================================================================
  // 2. persistNflRushingRows / persistNflReceivingRows: write every row,
  //    unfiltered.
  // =====================================================================
  const rushUpsertCalls: any[] = [];
  const originalRushUpsert = (prisma as any).nflRushingRow?.upsert;
  (prisma as any).nflRushingRow = {
    upsert: async (args: any) => {
      rushUpsertCalls.push(args);
      return args.create;
    },
  };

  const rushWritten = await persistNflRushingRows(pitAtlRushing);
  expect("persistNflRushingRows: returns count of every extracted rushing row", rushWritten, pitAtlRushing.length);
  ok(
    "persistNflRushingRows: upserts are keyed on (externalId, team, playerName)",
    rushUpsertCalls.every((c) => "externalId_team_playerName" in c.where)
  );
  if (originalRushUpsert) (prisma as any).nflRushingRow.upsert = originalRushUpsert;

  const recUpsertCalls: any[] = [];
  const originalRecUpsert = (prisma as any).nflReceivingRow?.upsert;
  (prisma as any).nflReceivingRow = {
    upsert: async (args: any) => {
      recUpsertCalls.push(args);
      return args.create;
    },
  };

  const recWritten = await persistNflReceivingRows(pitAtlReceiving);
  expect("persistNflReceivingRows: returns count of every extracted receiving row", recWritten, pitAtlReceiving.length);
  ok(
    "persistNflReceivingRows: Kyle Pitts Sr.-style 0-rec row IS written, not dropped",
    recUpsertCalls.some((c) => c.create.receptions === 0 && c.create.targets > 0)
  );
  ok(
    "persistNflReceivingRows: upserts are keyed on (externalId, team, playerName)",
    recUpsertCalls.every((c) => "externalId_team_playerName" in c.where)
  );
  if (originalRecUpsert) (prisma as any).nflReceivingRow.upsert = originalRecUpsert;

  const zeroRushWritten = await persistNflRushingRows([]);
  expect("persistNflRushingRows([]): writes nothing, returns 0", zeroRushWritten, 0);
  const zeroRecWritten = await persistNflReceivingRows([]);
  expect("persistNflReceivingRows([]): writes nothing, returns 0", zeroRecWritten, 0);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
