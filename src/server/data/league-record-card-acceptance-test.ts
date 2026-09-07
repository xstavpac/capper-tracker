// League-specific capper record card - the aggregation layer.
// Run with: npx tsx src/server/data/league-record-card-acceptance-test.ts
//
// Spec: two columns (Overall / [League]) for ONE bet-type category, both from
// the SAME pipeline (computeLeagueRecordCards -> computeCategoryBreakdown ->
// computeStats). Rules proven here:
//  - Aggregation Matrix filters, exactly: Overall = all leagues lifetime,
//    [League] = one league lifetime
//  - PENDING / CANCELLED excluded from both columns ("graded only")
//  - No minimum on Overall / League (1-0, 2-0 render as-is)
//  - win% is always derived from that column's own W-L count, never averaged
//    across subsets
//  - a segment-scoped pick (Q1, 2H, period, ...) never dilutes a full-game
//    category's card - it classifies under its own <period>_<side> key, which
//    gets its own card when `categories` includes it (the football/basketball/
//    hockey chip sets and ALL_CATEGORY_KEYS do; DEFAULT_CHIP_SET / MLB do not)
//
// The card's old third column, the capper's most-recent-20 record, is gone
// from this card: the /live "over the last 20 picks" row is now capper-wide
// (every category / league) and lives in recent-picks-record-acceptance-test.ts.

import { computeLeagueRecordCards, chipSetForLeague } from "@/server/data/stats";
import type { Pick } from "@prisma/client";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

type Row = Pick & { sport: { name: string } };
let pid = 0;
function p(over: {
  status: Pick["status"];
  sport: string;
  betType?: Pick["betType"];
  period?: Pick["period"];
  betDetail?: string;
  line?: number | null;
  day?: number;
}): Row {
  return {
    id: "p" + pid++,
    status: over.status,
    betType: over.betType ?? "SPREAD",
    period: over.period ?? "FULL_GAME",
    betDetail: over.betDetail ?? "Team +3.5",
    odds: -110,
    line: over.line ?? 3.5,
    units: 1,
    gameTime: new Date(2026, 0, over.day ?? ++pid),
    pickedSide: "AWAY",
    mlFavoredSide: null,
    sport: { name: over.sport },
  } as unknown as Row;
}

const dogSpread = (status: Pick["status"], sport: string, day?: number) =>
  p({ status, sport, betType: "SPREAD", betDetail: "Team +3.5", line: 3.5, day });

const card = (picks: Row[], league: string) =>
  computeLeagueRecordCards(picks, league, chipSetForLeague(league)).find((c) => c.category === "SPREAD_PLUS");

const wl = (col: { wins: number; losses: number; winPct: number } | null) =>
  col ? [col.wins, col.losses, Math.round(col.winPct)] : null;

// ---------------------------------------------------------------------------
console.log("########## Aggregation Matrix: the three columns' filters ##########");
{
  const picks = [
    dogSpread("WIN", "NCAAF"),
    dogSpread("WIN", "NCAAF"),
    dogSpread("LOSS", "NCAAF"),
    dogSpread("WIN", "NFL"), // other league
    dogSpread("LOSS", "NFL"),
    p({ status: "PENDING", sport: "NCAAF" }), // not graded
    p({ status: "CANCELLED", sport: "NCAAF" }), // not graded
  ];
  const c = card(picks, "NCAAF")!;
  check("Overall = all leagues, graded only -> 3-2", wl(c.overall), [3, 2, 60]);
  check("[League] = NCAAF only, graded only -> 2-1", wl(c.league), [2, 1, 67]);
  check("PENDING and CANCELLED are in neither column", [c.overall.wins + c.overall.losses, c.league.wins + c.league.losses], [5, 3]);
}

// ---------------------------------------------------------------------------
console.log("\n########## No minimum on Overall / League ##########");
{
  const c = card([dogSpread("WIN", "NCAAF")], "NCAAF")!;
  check("a single 1-0 record renders as-is (no gate)", wl(c.overall), [1, 0, 100]);
  check("League also 1-0", wl(c.league), [1, 0, 100]);
}
{
  const c = card([dogSpread("WIN", "NCAAF"), dogSpread("WIN", "NCAAF")], "NCAAF")!;
  check("2-0 renders as-is", wl(c.overall), [2, 0, 100]);
}

// ---------------------------------------------------------------------------
console.log("\n########## Overall reflects every graded pick in the category ##########");
{
  // 30 graded: first 25 WIN (days 1-25), last 5 LOSS (days 26-30).
  const c30picks = [
    ...Array.from({ length: 25 }, (_, i) => dogSpread("WIN", "NCAAF", i + 1)),
    ...Array.from({ length: 5 }, (_, i) => dogSpread("LOSS", "NCAAF", i + 26)),
  ];
  const c30 = card(c30picks, "NCAAF")!;
  check("30 graded -> Overall 25-5", wl(c30.overall), [25, 5, 83]);
}

// ---------------------------------------------------------------------------
console.log("\n########## win% is derived from the aggregate, never averaged ##########");
{
  // NCAAF: 1-0 (100%). NFL: 0-3 (0%). Averaging the two subset %s would give
  // 50%. The real aggregate is 1-3 -> 25%.
  const picks = [
    dogSpread("WIN", "NCAAF"),
    dogSpread("LOSS", "NFL"),
    dogSpread("LOSS", "NFL"),
    dogSpread("LOSS", "NFL"),
  ];
  const c = card(picks, "NCAAF")!;
  check("Overall win% = 1/(1+3) = 25%, NOT the 50% average of 100% and 0%", Math.round(c.overall.winPct), 25);
  check("[League] win% = NCAAF's own 1-0 = 100%", Math.round(c.league.winPct), 100);
}

// ---------------------------------------------------------------------------
console.log("\n########## a segment pick never dilutes a full-game category's card ##########");
{
  // 3 full-game underdog spreads (2-1) + 6 first-quarter spreads (all WIN) +
  // 4 second-half spreads (all WIN), all NCAAF. The full-game SPREAD_PLUS
  // card must read the 3 full-game picks only; the segment picks get their
  // own separate cards (NCAAF's chip set now carries the segment keys).
  const picks = [
    dogSpread("WIN", "NCAAF", 1),
    dogSpread("WIN", "NCAAF", 2),
    dogSpread("LOSS", "NCAAF", 3),
    ...Array.from({ length: 6 }, (_, i) => p({ status: "WIN", sport: "NCAAF", betType: "SPREAD", period: "FIRST_QUARTER", betDetail: "Team 1Q +2.5", line: 2.5, day: 10 + i })),
    ...Array.from({ length: 4 }, (_, i) => p({ status: "WIN", sport: "NCAAF", betType: "SPREAD", period: "SECOND_HALF", betDetail: "Team 2H +1.5", line: 1.5, day: 20 + i })),
  ];
  const c = card(picks, "NCAAF")!;
  check("SPREAD_PLUS card: Overall = the 3 full-game picks only -> 2-1", wl(c.overall), [2, 1, 67]);
  check("SPREAD_PLUS card: [League] = the 3 full-game picks only -> 2-1", wl(c.league), [2, 1, 67]);

  const cards = computeLeagueRecordCards(picks, "NCAAF", chipSetForLeague("NCAAF"));
  check(
    "the segment spreads get their own separate cards, each with its own record",
    cards.map((x) => [x.category, x.overall.wins, x.overall.losses]),
    [
      ["SPREAD_PLUS", 2, 1],
      ["FIRST_QUARTER_SPREAD", 6, 0],
      ["SECOND_HALF_SPREAD", 4, 0],
    ]
  );

  // ...but with a chip set that excludes segments (MLB / DEFAULT), only the
  // full-game card comes back.
  check(
    "MLB chip set (no segment keys): only the SPREAD_PLUS card",
    computeLeagueRecordCards(picks, "NCAAF", chipSetForLeague("MLB")).map((x) => x.category),
    ["SPREAD_PLUS"]
  );
}

// ---------------------------------------------------------------------------
console.log("\n########## League column matches Overall for a single-league capper ##########");
{
  const picks = Array.from({ length: 24 }, (_, i) => dogSpread(i % 3 === 0 ? "LOSS" : "WIN", "NCAAF", i + 1));
  const c = card(picks, "NCAAF")!;
  check("single-league capper: League === Overall", JSON.stringify(c.league), JSON.stringify(c.overall));
  check("...and both are the real 16-8 record", wl(c.overall), [16, 8, 67]);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
