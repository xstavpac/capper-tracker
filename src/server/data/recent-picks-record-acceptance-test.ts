// The capper-wide "over the last 20 picks" row on the /live game card - the
// aggregation layer. Proves recentRecordColumn / recentPicksRecord (stats.ts),
// which getCapperLeagueRecords calls once per capper over that capper's ENTIRE
// pick history - every category, every league, segment (Q1-Q4 / half / period)
// picks included. That is a different population from the category-scoped
// Overall / League columns on the same card (league-record-card-acceptance-
// test.ts), and the whole point of the change: the row is no longer filtered
// to the category the card is about.
//
// Rules proven here:
//  - the window is the most-recent N GRADED picks by gameTime, drawn from
//    across categories / leagues / segment periods - never one category
//  - PENDING / CANCELLED never count
//  - pushes count toward the sample + the W-L-P string, not the win%
//  - recentPicksRecord returns null below `minGraded` graded picks (the /live
//    row is then omitted, never a partial "last N"); at/above it, the record,
//    with win% always derived from the window's own W-L count
//
// Pure - no DB. Run with:
//   npx tsx src/server/data/recent-picks-record-acceptance-test.ts
import { recentRecordColumn, recentPicksRecord, LEAGUE_RECORD_LAST_N } from "@/server/data/stats";
import type { Pick } from "@prisma/client";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

let pid = 0;
function p(over: {
  status: Pick["status"];
  day: number;
  betType?: Pick["betType"];
  period?: Pick["period"];
}): Pick {
  return {
    id: "p" + pid++,
    status: over.status,
    betType: over.betType ?? "SPREAD",
    period: over.period ?? "FULL_GAME",
    betDetail: "Team +3.5",
    odds: -110,
    line: 3.5,
    units: 1,
    gameTime: new Date(2026, 0, over.day),
    pickedSide: "AWAY",
    mlFavoredSide: null,
  } as unknown as Pick;
}

// ---------------------------------------------------------------------------
console.log("########## the window spans categories / leagues / segments ##########");
{
  // 25 graded picks, deliberately mixed - full-game spreads / moneylines /
  // totals plus first-quarter and second-half segment picks. Newest 20 by
  // gameTime are days 6..25: 12 full-game W + 4 segment W + 4 segment L.
  const picks: Pick[] = [
    ...Array.from({ length: 5 }, (_, i) => p({ status: "LOSS", day: i + 1 })), // oldest, outside the window
    ...Array.from({ length: 12 }, (_, i) => p({ status: "WIN", day: i + 6, betType: i % 2 ? "MONEYLINE" : "TOTAL" })),
    ...Array.from({ length: 4 }, (_, i) => p({ status: "WIN", day: i + 18, period: "FIRST_QUARTER" })),
    ...Array.from({ length: 4 }, (_, i) => p({ status: "LOSS", day: i + 22, period: "SECOND_HALF" })),
  ];
  const col = recentRecordColumn(picks, LEAGUE_RECORD_LAST_N);
  check("last 20 by gameTime -> 16-4 (segment picks counted, not excluded)", [col.wins, col.losses], [16, 4]);
  check("the 5 oldest losses fall outside the window", col.count, 20);
  check("win% from the window's own count: 16/20 = 80%", Math.round(col.winPct), 80);
}

// ---------------------------------------------------------------------------
console.log("\n########## PENDING / CANCELLED never count ##########");
{
  const picks: Pick[] = [
    ...Array.from({ length: 10 }, (_, i) => p({ status: "WIN", day: i + 1 })),
    ...Array.from({ length: 10 }, (_, i) => p({ status: "LOSS", day: i + 11 })),
    ...Array.from({ length: 5 }, (_, i) => p({ status: "PENDING", day: i + 21 })),
    ...Array.from({ length: 5 }, (_, i) => p({ status: "CANCELLED", day: i + 26 })),
  ];
  const col = recentRecordColumn(picks, LEAGUE_RECORD_LAST_N);
  check("20 graded (PENDING / CANCELLED skipped) -> 10-10", [col.wins, col.losses, col.count], [10, 10, 20]);
}

// ---------------------------------------------------------------------------
console.log("\n########## pushes: toward the sample + W-L-P, not the win% ##########");
{
  const picks: Pick[] = [
    ...Array.from({ length: 12 }, (_, i) => p({ status: "WIN", day: i + 1 })),
    ...Array.from({ length: 4 }, (_, i) => p({ status: "LOSS", day: i + 13 })),
    ...Array.from({ length: 4 }, (_, i) => p({ status: "PUSH", day: i + 17 })),
  ];
  const col = recentRecordColumn(picks, LEAGUE_RECORD_LAST_N);
  check(
    "12-4-4, count 20, win% = 12/(12+4) = 75%",
    { wins: col.wins, losses: col.losses, pushes: col.pushes, winPct: Math.round(col.winPct), count: col.count },
    { wins: 12, losses: 4, pushes: 4, winPct: 75, count: 20 }
  );
}

// ---------------------------------------------------------------------------
console.log("\n########## recentPicksRecord: the 20-graded-pick minimum ##########");
{
  const nineteen = Array.from({ length: 19 }, (_, i) => p({ status: "WIN", day: i + 1 }));
  check(
    "19 graded -> null (row omitted, never a partial 'last N')",
    recentPicksRecord(nineteen, LEAGUE_RECORD_LAST_N, LEAGUE_RECORD_LAST_N),
    null
  );

  const twenty = Array.from({ length: 20 }, (_, i) => p({ status: i < 13 ? "WIN" : "LOSS", day: i + 1 }));
  const c20 = recentPicksRecord(twenty, LEAGUE_RECORD_LAST_N, LEAGUE_RECORD_LAST_N);
  check("exactly 20 graded -> populated (13-7)", c20 && [c20.wins, c20.losses], [13, 7]);

  // The gate is on GRADED picks: 19 graded + 10 pending is still below it.
  const mixed = [...nineteen, ...Array.from({ length: 10 }, (_, i) => p({ status: "PENDING", day: i + 40 }))];
  check("19 graded + 10 pending -> still null", recentPicksRecord(mixed, LEAGUE_RECORD_LAST_N, LEAGUE_RECORD_LAST_N), null);

  // 30 graded: days 1-25 WIN, 26-30 LOSS. The window is the newest 20 by
  // gameTime = days 11-30 = 15 W + 5 L, NOT the all-time 25-5.
  const thirty = [
    ...Array.from({ length: 25 }, (_, i) => p({ status: "WIN", day: i + 1 })),
    ...Array.from({ length: 5 }, (_, i) => p({ status: "LOSS", day: i + 26 })),
  ];
  const c30 = recentPicksRecord(thirty, LEAGUE_RECORD_LAST_N, LEAGUE_RECORD_LAST_N)!;
  check("30 graded -> window is the newest 20 by gameTime (15-5), not all-time", [c30.wins, c30.losses], [15, 5]);
}

// ---------------------------------------------------------------------------
console.log("\n########## a small window still works (helper is window-agnostic) ##########");
{
  const picks = [
    p({ status: "LOSS", day: 1 }),
    p({ status: "LOSS", day: 2 }),
    p({ status: "WIN", day: 3 }),
    p({ status: "WIN", day: 4 }),
    p({ status: "WIN", day: 5 }),
  ];
  check("window 3 -> the 3 newest by gameTime (3-0)", (() => { const c = recentRecordColumn(picks, 3); return [c.wins, c.losses]; })(), [3, 0]);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
