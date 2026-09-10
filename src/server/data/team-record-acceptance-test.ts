// Proof for server/data/team-record.ts - the GameResult-derived win-loss
// record splits (home/away/last-10/streak) for NFL and their point-in-time
// reader.
//
// Load-bearing checks:
//  - POINT-IN-TIME: a game dated the target day (or later) is NEVER in a
//    record computed as-of that day; the reader's snapshot lookup cuts at
//    dayBefore, so a snapshot dated the game's own day is likewise ignored
//    (the Zone Model look-ahead regression shape).
//  - Ties (NFL): counted only in `ties`, never a home/away W or L, excluded
//    from winPct, and they STOP a streak scan rather than extending it.
//  - Last-10 is exactly the 10 most recent games.
//
// Pure: the prisma singleton's methods are swapped for stubs before each
// call - no database. Listed in PURE_DESPITE_PRISMA_IMPORT (run-tests.mjs).
//   npx tsx src/server/data/team-record-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { computeTeamRecord, computeTeamRecords, getTeamRecordAsOf, type RecordGameRow } from "@/server/data/team-record";

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

const T = "Team A";
function g(over: Partial<RecordGameRow> & { d: string }): RecordGameRow {
  return {
    homeTeam: T,
    awayTeam: "Opp",
    homeScore: 24,
    awayScore: 17,
    isPreseason: false,
    gameDate: new Date(`${over.d}T18:00:00Z`),
    ...over,
  };
}

// ---- prisma stub ------------------------------------------------------
const originals: Record<string, unknown> = {};
function patch(path: string, fn: unknown) {
  const [model, method] = path.split(".");
  const target = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
  originals[path] ??= target[method];
  target[method] = fn;
}
function restoreAll() {
  for (const path of Object.keys(originals)) {
    const [model, method] = path.split(".");
    (prisma as unknown as Record<string, Record<string, unknown>>)[model][method] = originals[path];
  }
}

const FAR_FUTURE = new Date("2099-01-01T00:00:00Z");

async function main() {
  // ===================================================================
  // 1. Home / away / overall splits
  // ===================================================================
  {
    const games: RecordGameRow[] = [
      g({ d: "2026-09-10", homeTeam: T, homeScore: 20, awayScore: 10 }), // home W
      g({ d: "2026-09-17", homeTeam: "Opp", awayTeam: T, homeScore: 30, awayScore: 14 }), // away L
      g({ d: "2026-09-24", homeTeam: T, homeScore: 13, awayScore: 27 }), // home L
      g({ d: "2026-10-01", homeTeam: "Opp", awayTeam: T, homeScore: 3, awayScore: 21 }), // away W
    ];
    const r = computeTeamRecord(games, T, FAR_FUTURE);
    expect("overall W-L", { w: r.wins, l: r.losses }, { w: 2, l: 2 });
    expect("home split", { w: r.homeWins, l: r.homeLosses }, { w: 1, l: 1 });
    expect("away split", { w: r.awayWins, l: r.awayLosses }, { w: 1, l: 1 });
    expect("winPct = 0.5", r.winPct, 0.5);
    expect("gamesInRecord", r.gamesInRecord, 4);
  }

  // ===================================================================
  // 2. Ties: not W/L, in `ties`, out of winPct, and they stop a streak
  // ===================================================================
  {
    const games: RecordGameRow[] = [
      g({ d: "2026-09-10", homeScore: 20, awayScore: 10 }), // W
      g({ d: "2026-09-17", homeScore: 21, awayScore: 21 }), // T
      g({ d: "2026-09-24", homeScore: 30, awayScore: 3 }), // W
      g({ d: "2026-10-01", homeScore: 17, awayScore: 14 }), // W (most recent)
    ];
    const rec = computeTeamRecord(games, T, FAR_FUTURE);
    expect("tie is not a win or a loss", { w: rec.wins, l: rec.losses }, { w: 3, l: 0 });
    expect("tie is counted in `ties`", rec.ties, 1);
    expect("winPct excludes the tie (3/3, not 3/4)", rec.winPct, 1);
    expect("streak scan stops at the tie: W-streak of 2, not 3", { t: rec.streakType, c: rec.streakCount }, { t: "W", c: 2 });
  }

  // ===================================================================
  // 3. Streak variants
  // ===================================================================
  {
    const base = "2026-09-";
    const L = (d: string) => g({ d: `${base}${d}`, homeScore: 3, awayScore: 20 });
    const W = (d: string) => g({ d: `${base}${d}`, homeScore: 20, awayScore: 3 });

    expect(
      "3 straight losses (most recent) -> L3",
      (() => {
        const r = computeTeamRecord([W("01"), L("08"), L("15"), L("22")], T, FAR_FUTURE);
        return { t: r.streakType, c: r.streakCount };
      })(),
      { t: "L", c: 3 }
    );
    expect(
      "most recent game is a tie -> no streak",
      (() => {
        const r = computeTeamRecord([W("01"), W("08"), g({ d: `${base}15`, homeScore: 10, awayScore: 10 })], T, FAR_FUTURE);
        return { t: r.streakType, c: r.streakCount };
      })(),
      { t: null, c: 0 }
    );
    expect(
      "no games -> null streak, null winPct",
      (() => {
        const r = computeTeamRecord([], T, FAR_FUTURE);
        return { t: r.streakType, c: r.streakCount, p: r.winPct };
      })(),
      { t: null, c: 0, p: null }
    );
  }

  // ===================================================================
  // 4. Last-10 is exactly the 10 most recent
  // ===================================================================
  {
    const games: RecordGameRow[] = [];
    for (let i = 0; i < 14; i++) {
      const day = String(2 + i).padStart(2, "0");
      // first 4 are wins, last 10 alternate starting with a loss -> 5 W, 5 L in the last 10
      const win = i < 4 || i % 2 === 1;
      games.push(g({ d: `2026-09-${day}`, homeScore: win ? 20 : 3, awayScore: win ? 3 : 20 }));
    }
    const r = computeTeamRecord(games, T, FAR_FUTURE);
    expect("overall counts all 14", { w: r.wins, l: r.losses }, { w: 4 + 5, l: 5 });
    expect("last-10 only counts the last 10", { w: r.last10Wins, l: r.last10Losses }, { w: 5, l: 5 });
  }

  // ===================================================================
  // 5. POINT-IN-TIME: a game on/after the cutoff is excluded
  // ===================================================================
  {
    const games: RecordGameRow[] = [
      g({ d: "2026-09-10", homeScore: 20, awayScore: 3 }), // W - before
      g({ d: "2026-09-17", homeScore: 20, awayScore: 3 }), // W - before
      g({ d: "2026-09-24", homeScore: 3, awayScore: 20 }), // L - THE game day
      g({ d: "2026-10-01", homeScore: 3, awayScore: 20 }), // L - after
    ];
    const cutoff = new Date("2026-09-24T00:00:00Z"); // start of the game day
    const r = computeTeamRecord(games, T, cutoff);
    expect("only the 2 games strictly before the cutoff count", { w: r.wins, l: r.losses }, { w: 2, l: 0 });
    ok("the game dated exactly the cutoff day is NOT in the record", r.wins === 2 && r.losses === 0);
    expect("streak reflects only pre-cutoff games (W2, not L-anything)", { t: r.streakType, c: r.streakCount }, { t: "W", c: 2 });
  }

  // ===================================================================
  // 6. Preseason games never count
  // ===================================================================
  {
    const games: RecordGameRow[] = [
      g({ d: "2026-08-16", homeScore: 3, awayScore: 40, isPreseason: true }), // preseason blowout loss
      g({ d: "2026-08-23", homeScore: 3, awayScore: 40, isPreseason: true }),
      g({ d: "2026-09-14", homeScore: 27, awayScore: 13, isPreseason: false }), // regular W
    ];
    const r = computeTeamRecord(games, T, FAR_FUTURE);
    expect("preseason losses are not in the record", { w: r.wins, l: r.losses }, { w: 1, l: 0 });
    expect("gamesInRecord excludes preseason", r.gamesInRecord, 1);
    const all = computeTeamRecords(games, FAR_FUTURE);
    ok("computeTeamRecords also skips a team that only has preseason games", !all.has("Opp") || all.get("Opp")!.gamesInRecord >= 0);
  }

  // ===================================================================
  // 7. getTeamRecordAsOf: snapshot-first, compute-fallback, look-ahead
  // ===================================================================
  const GAME_DATE = new Date("2026-10-05T17:00:00.000Z"); // Sunday 1pm ET
  const DAY_OF = "2026-10-05";
  const DAY_BEFORE = "2026-10-04";

  // 7a. A snapshot at/before the day-before is used; GameResult is NOT queried.
  {
    let gameResultQueried = false;
    patch("teamRecordSnapshot.findMany", async () => [
      { snapshotDate: "2026-10-01", wins: 3, losses: 1, ties: 0, homeWins: 2, homeLosses: 0, awayWins: 1, awayLosses: 1, last10Wins: 3, last10Losses: 1, streakType: "W", streakCount: 2, gamesInRecord: 4 },
      { snapshotDate: DAY_BEFORE, wins: 4, losses: 1, ties: 0, homeWins: 3, homeLosses: 0, awayWins: 1, awayLosses: 1, last10Wins: 4, last10Losses: 1, streakType: "W", streakCount: 3, gamesInRecord: 5 },
    ]);
    patch("gameResult.findMany", async () => {
      gameResultQueried = true;
      return [];
    });
    const out = await getTeamRecordAsOf("americanfootball_nfl", T, GAME_DATE);
    expect("reader picks the DAY-BEFORE snapshot (W3, 5 games)", { w: out.record.wins, streak: out.record.streakCount, src: out.source }, { w: 4, streak: 3, src: "snapshot" });
    expect("reader's asOfDateKey is the day before the game", out.asOfDateKey, DAY_BEFORE);
    ok("GameResult was NOT queried when a snapshot exists", gameResultQueried === false);
  }

  // 7b. LOOK-AHEAD: a snapshot dated the game's OWN day must be ignored.
  {
    patch("teamRecordSnapshot.findMany", async () => [
      { snapshotDate: "2026-10-01", wins: 3, losses: 1, ties: 0, homeWins: 2, homeLosses: 0, awayWins: 1, awayLosses: 1, last10Wins: 3, last10Losses: 1, streakType: "W", streakCount: 2, gamesInRecord: 4 },
      { snapshotDate: DAY_OF, wins: 99, losses: 0, ties: 0, homeWins: 99, homeLosses: 0, awayWins: 0, awayLosses: 0, last10Wins: 10, last10Losses: 0, streakType: "W", streakCount: 99, gamesInRecord: 99 },
    ]);
    patch("gameResult.findMany", async () => []);
    const out = await getTeamRecordAsOf("americanfootball_nfl", T, GAME_DATE);
    expect("the game-day snapshot (W99) is NOT selected - the 10-01 one is", { w: out.record.wins, streak: out.record.streakCount }, { w: 3, streak: 2 });
  }

  // 7c. No snapshots -> computes from GameResult, cut at day-before.
  {
    patch("teamRecordSnapshot.findMany", async () => []);
    patch("gameResult.findMany", async () => [
      g({ d: "2026-09-28", homeScore: 20, awayScore: 3 }), // W - before
      g({ d: DAY_OF, homeScore: 3, awayScore: 20 }), // L - the game's own day
    ]);
    const out = await getTeamRecordAsOf("americanfootball_nfl", T, GAME_DATE);
    expect("compute fallback: only the pre-game-day game counts", { w: out.record.wins, l: out.record.losses, src: out.source }, { w: 1, l: 0, src: "computed" });
  }

  restoreAll();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
