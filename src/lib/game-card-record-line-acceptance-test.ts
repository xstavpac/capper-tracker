// The condensed three-number game-card record line - run with:
//   npx tsx src/lib/game-card-record-line-acceptance-test.ts
//
// Replaces the verbose per-pick line
//   "12-3 (80%) all-time | 4-1 (80%) last 20 on underdog spread picks"
// with "Team +3.5 · Ovr 12-3 · NCAAF 8-2 (80%) · L20 4-1".
// Proven here:
//  - renders correctly ABOVE the Last-20 threshold (all three segments)
//  - renders correctly BELOW it (L20 segment dropped entirely - no inline
//    "Need 20 picks")
//  - pushes are shown (12-3-1)
//  - it fits one line at mobile width for a typical pick, and for a game with
//    8+ stacked picks stays the same vertical footprint (one row each) - only
//    an unusually long team name wraps it, exactly as the verbose line did
//    for EVERY pick

import {
  gameCardRecordSegments,
  gameCardRecordPortionText,
  gameCardRecordLineText,
  estimateGameCardLineWidthPx,
  GAME_CARD_LINE_MOBILE_BUDGET_PX,
  GAME_CARD_RECORD_PORTION_BUDGET_PX,
} from "@/lib/game-card-record-line";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
function checkLt(label: string, actual: number, limit: number) {
  const pass = actual <= limit;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> ${actual} <= ${limit}`);
  if (!pass) failures++;
}

const col = (wins: number, losses: number, pushes = 0) => ({
  wins,
  losses,
  pushes,
  winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0,
});
const N = 20;

// ---------------------------------------------------------------------------
console.log("########## renders above / below the Last-20 threshold ##########");
{
  const card = { overall: col(12, 3), league: col(8, 2), last20: col(4, 1) };
  const segs = gameCardRecordSegments(card, "NCAAF", N);
  check("3 segments above threshold", segs.map((s) => s.label), ["Ovr", "NCAAF", "L20"]);
  check(
    "exact line text (Ovr no %, league %, L20 bare)",
    gameCardRecordLineText("Team +3.5", segs),
    "Team +3.5 · Ovr 12-3 · NCAAF 8-2 (80%) · L20 4-1"
  );
  check("only the current-league segment is emphasized", segs.map((s) => s.emphasized), [false, true, false]);
  check("only the current-league segment carries a %", segs.map((s) => s.pct), [null, "80%", null]);
}
{
  const card = { overall: col(6, 3), league: col(4, 2), last20: null };
  const segs = gameCardRecordSegments(card, "NCAAF", N);
  check("below threshold: L20 segment is dropped entirely", segs.map((s) => s.label), ["Ovr", "NCAAF"]);
  check(
    "below threshold line text - no 'Need 20 picks', just absent",
    gameCardRecordLineText("Team +3.5", segs),
    "Team +3.5 · Ovr 6-3 · NCAAF 4-2 (67%)"
  );
}
{
  const card = { overall: col(3, 3, 1), league: col(2, 2, 1), last20: null };
  check(
    "pushes render in the record (12-3-1 style)",
    gameCardRecordPortionText(gameCardRecordSegments(card, "NBA", N)),
    "Ovr 3-3-1 · NBA 2-2-1 (50%)"
  );
}

// ---------------------------------------------------------------------------
console.log("\n##########  mobile width: one line for a typical pick  ##########");
{
  const card = { overall: col(12, 3), league: col(8, 2), last20: col(4, 1) };
  const segs = gameCardRecordSegments(card, "NCAAF", N);
  checkLt(
    "record portion fits its budget (so it shares a line with a normal bet detail)",
    estimateGameCardLineWidthPx(gameCardRecordPortionText(segs)),
    GAME_CARD_RECORD_PORTION_BUDGET_PX
  );
  for (const bet of ["Team +3.5", "Over 55.5", "UNLV +7", "Bama -3.5", "Under 210.5"]) {
    checkLt(
      `full line fits mobile budget: "${bet}"`,
      estimateGameCardLineWidthPx(gameCardRecordLineText(bet, segs)),
      GAME_CARD_LINE_MOBILE_BUDGET_PX
    );
  }
}

// ---------------------------------------------------------------------------
console.log("\n##########  8+ stacked picks (UNLV / Washington State density)  ##########");
{
  // A dense game card: 9 picks, varied bet types, one long team name.
  const card = { overall: col(11, 1), league: col(7, 1), last20: col(5, 3) };
  const segsAbove = gameCardRecordSegments(card, "NCAAF", N);
  const segsBelow = gameCardRecordSegments({ overall: col(4, 2), league: col(2, 1), last20: null }, "NCAAF", N);
  const stacked = [
    { bet: "UNLV +7", segs: segsAbove },
    { bet: "Washington State -7", segs: segsAbove },
    { bet: "Over 55.5", segs: segsAbove },
    { bet: "Under 55.5", segs: segsBelow },
    { bet: "UNLV ML", segs: segsBelow },
    { bet: "Washington State ML", segs: segsAbove },
    { bet: "UNLV 1H +3.5", segs: segsBelow },
    { bet: "Over 27.5 1H", segs: segsAbove },
    { bet: "Washington State TT o24.5", segs: segsBelow },
  ];
  // Every pick's record PORTION fits without forcing its own wrap - so the
  // expander's height is (row per pick), not (2-3 rows per pick like the old
  // line, which wrapped for every pick).
  const portionOverflows = stacked.filter(
    (p) => estimateGameCardLineWidthPx(gameCardRecordPortionText(p.segs)) > GAME_CARD_RECORD_PORTION_BUDGET_PX
  );
  check("no pick's record portion overflows (each stays one row)", portionOverflows.map((p) => p.bet), []);

  // Full-line overflow is driven ONLY by a long team name in the bet detail -
  // and even then it wraps to 2 rows, never more. The verbose line it replaces
  // wrapped 2-3 rows for EVERY pick, so this is strictly better.
  const fullOverflows = stacked.filter(
    (p) => estimateGameCardLineWidthPx(gameCardRecordLineText(p.bet, p.segs)) > GAME_CARD_LINE_MOBILE_BUDGET_PX
  );
  check(
    "only the long-team-name picks push the full line past one row",
    fullOverflows.map((p) => p.bet).sort(),
    ["Washington State -7", "Washington State ML", "Washington State TT o24.5"]
  );
  check(
    "the majority of a dense card's picks are a clean single line",
    stacked.length - fullOverflows.length >= 6,
    true
  );
}

// ---------------------------------------------------------------------------
console.log("\n##########  strictly shorter than the verbose line it replaces  ##########");
{
  const card = { overall: col(12, 3), league: col(8, 2), last20: col(4, 1) };
  const condensed = gameCardRecordPortionText(gameCardRecordSegments(card, "NCAAF", N));
  // The old format, same data: "12-3 (80%) all-time | 4-1 (80%) last 20 on underdog spread picks"
  const verbose = "12-3 (80%) all-time | 4-1 (80%) last 20 on underdog spread picks";
  checkLt("condensed record portion is well under the old verbose portion", condensed.length, Math.floor(verbose.length * 0.7));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
