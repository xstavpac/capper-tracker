// Proof for the NFL situational-rate snapshot layer:
//   - computeAllTeamsNflSituationalRates (shared evaluator) - the new
//     "trailedAtHalftime" mirror question's correctness, preseason exclusion,
//     and the asOf point-in-time cutoff.
//   - getSituationalRatesAsOf (reader) - snapshot-first / compute-fallback,
//     and the same-day-snapshot-must-not-leak look-ahead regression.
//
// Pure: prisma methods are stubbed before each call. Listed in
// PURE_DESPITE_PRISMA_IMPORT (run-tests.mjs).
//   npx tsx src/server/data/situational-snapshot-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import {
  computeAllTeamsNflSituationalRates,
  type NflSituationalGameRow,
} from "@/server/data/nfl-game-pulse-situations";
import { getSituationalRatesAsOf } from "@/server/data/situational-snapshots";

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

// A game where `home` trailed at halftime (Q1+Q2: home behind), with a
// caller-chosen final score.
function trailedAtHalfGame(over: {
  d: string;
  homeScore: number;
  awayScore: number;
  isPreseason?: boolean;
  home?: string;
  away?: string;
}): NflSituationalGameRow {
  return {
    homeTeam: over.home ?? "Home",
    awayTeam: over.away ?? "Away",
    homeScore: over.homeScore,
    awayScore: over.awayScore,
    gameDate: new Date(`${over.d}T18:00:00Z`),
    isPreseason: over.isPreseason ?? false,
    quartersJson: [
      { home: 0, away: 10 },
      { home: 7, away: 0 },
      { home: 0, away: 0 },
      { home: 0, away: 0 },
    ],
    scoringPlaysJson: null,
    homeTurnovers: null,
    awayTurnovers: null,
  };
}

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

async function main() {
  // ===================================================================
  // 1. trailedAtHalftime: holder is the trailing side; winPct = comeback rate
  // ===================================================================
  {
    const games: NflSituationalGameRow[] = [
      trailedAtHalfGame({ d: "2026-09-13", homeScore: 24, awayScore: 21 }), // Home trailed at half, WON (comeback)
      trailedAtHalfGame({ d: "2026-09-20", homeScore: 30, awayScore: 17 }), // Home trailed at half, WON
      trailedAtHalfGame({ d: "2026-09-27", homeScore: 10, awayScore: 34 }), // Home trailed at half, LOST
    ];
    const rates = computeAllTeamsNflSituationalRates(games);
    const home = rates.get("Home")!;
    expect(
      "Home trailed at half in all 3 -> total 3, wins 2 (the comebacks)",
      { w: home.trailedAtHalftime.wins, t: home.trailedAtHalftime.total },
      { w: 2, t: 3 }
    );
    ok("Home's trailed-at-half winPct is the comeback rate (~66.67)", Math.abs(home.trailedAtHalftime.winPct - 200 / 3) < 0.01, home.trailedAtHalftime.winPct);

    const away = rates.get("Away")!;
    expect(
      "the mirror: Away LED at half in all 3, won 1 -> leadingAtHalftime total 3, wins 1",
      { w: away.leadingAtHalftime.wins, t: away.leadingAtHalftime.total },
      { w: 1, t: 3 }
    );
    expect("Away never 'trailed at half' here", away.trailedAtHalftime, { wins: 0, total: 0, winPct: 0 });
  }

  // ===================================================================
  // 2. Preseason games never count
  // ===================================================================
  {
    const games: NflSituationalGameRow[] = [
      trailedAtHalfGame({ d: "2026-08-16", homeScore: 40, awayScore: 3, isPreseason: true }), // preseason comeback - must be ignored
      trailedAtHalfGame({ d: "2026-09-13", homeScore: 24, awayScore: 21, isPreseason: false }),
    ];
    const home = computeAllTeamsNflSituationalRates(games).get("Home")!;
    expect("only the 1 regular-season game counts", { w: home.trailedAtHalftime.wins, t: home.trailedAtHalftime.total }, { w: 1, t: 1 });
  }

  // ===================================================================
  // 3. asOf cutoff: a game on/after the cutoff is excluded
  // ===================================================================
  {
    const games: NflSituationalGameRow[] = [
      trailedAtHalfGame({ d: "2026-09-13", homeScore: 24, awayScore: 21 }), // before
      trailedAtHalfGame({ d: "2026-09-20", homeScore: 3, awayScore: 40 }), // ON the cutoff day
      trailedAtHalfGame({ d: "2026-09-27", homeScore: 3, awayScore: 40 }), // after
    ];
    const cutoff = new Date("2026-09-20T00:00:00Z");
    const home = computeAllTeamsNflSituationalRates(games, cutoff).get("Home")!;
    expect("only the game strictly before the cutoff counts", { w: home.trailedAtHalftime.wins, t: home.trailedAtHalftime.total }, { w: 1, t: 1 });
  }

  // ===================================================================
  // 4. getSituationalRatesAsOf: snapshot-first / compute-fallback / look-ahead
  // ===================================================================
  const GAME_DATE = new Date("2026-10-05T17:00:00.000Z");
  const DAY_OF = "2026-10-05";
  const DAY_BEFORE = "2026-10-04";

  // 4a. snapshot at/before the day-before is used; GameResult NOT queried.
  {
    let gameResultQueried = false;
    patch("situationalRateSnapshot.findMany", async () => [
      { snapshotDate: "2026-10-01", questionKey: "trailedAtHalftime", wins: 1, total: 4 },
      { snapshotDate: DAY_BEFORE, questionKey: "trailedAtHalftime", wins: 3, total: 5 },
      { snapshotDate: DAY_BEFORE, questionKey: "scoredFirst", wins: 6, total: 8 },
    ]);
    patch("gameResult.findMany", async () => {
      gameResultQueried = true;
      return [];
    });
    const out = await getSituationalRatesAsOf("Home", GAME_DATE);
    expect("reader picks the DAY-BEFORE snapshot", { w: out.rates.trailedAtHalftime.wins, t: out.rates.trailedAtHalftime.total, src: out.source }, { w: 3, t: 5, src: "snapshot" });
    expect("other questions from that same snapshot date carried through", { w: out.rates.scoredFirst.wins, t: out.rates.scoredFirst.total }, { w: 6, t: 8 });
    expect("asOfDateKey is the day before the game", out.asOfDateKey, DAY_BEFORE);
    ok("GameResult was NOT queried", gameResultQueried === false);
  }

  // 4b. LOOK-AHEAD: a snapshot dated the game's own day must be ignored.
  {
    patch("situationalRateSnapshot.findMany", async () => [
      { snapshotDate: "2026-10-01", questionKey: "trailedAtHalftime", wins: 1, total: 4 },
      { snapshotDate: DAY_OF, questionKey: "trailedAtHalftime", wins: 99, total: 99 },
    ]);
    patch("gameResult.findMany", async () => []);
    const out = await getSituationalRatesAsOf("Home", GAME_DATE);
    expect("the game-day snapshot (99/99) is NOT selected - the 10-01 one is", { w: out.rates.trailedAtHalftime.wins, t: out.rates.trailedAtHalftime.total }, { w: 1, t: 4 });
  }

  // 4c. no snapshots -> compute from GameResult (via getNflTeamSituationalRates).
  {
    patch("situationalRateSnapshot.findMany", async () => []);
    patch("gameResult.findMany", async () => [
      trailedAtHalfGame({ d: "2026-09-28", homeScore: 24, awayScore: 21, home: "Home" }), // before, comeback W
      trailedAtHalfGame({ d: DAY_OF, homeScore: 3, awayScore: 40, home: "Home" }), // the game's own day - must not leak
    ]);
    const out = await getSituationalRatesAsOf("Home", GAME_DATE);
    expect("compute fallback: only the pre-game-day game counts", { w: out.rates.trailedAtHalftime.wins, t: out.rates.trailedAtHalftime.total, src: out.source }, { w: 1, t: 1, src: "computed" });
  }

  restoreAll();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
