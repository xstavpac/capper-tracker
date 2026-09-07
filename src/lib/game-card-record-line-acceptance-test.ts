// The condensed three-number game-card record line - run with:
//   npx tsx src/lib/game-card-record-line-acceptance-test.ts
//
// Final format (PR #25 review):
//   "Team +3.5 · All 12-3 80% | NCAAF 8-2 80% | L20 4-1 80%"
//   - "All" / <league> / "L20"; "|" between segments, "·" before the first
//   - record then win%, space-separated, no parentheses
//   - every segment colored by its own record; the league segment also bold
//   - L20 (segment + its "|") dropped entirely below the 20-graded threshold
//
// Proven here: exact text above/below threshold, pushes, the trailing 🔥/🧊
// overall-streak indicator, and the mobile-width behaviour - including the two
// stress cases the format was reviewed against (a long college team name, and
// a 3-digit lifetime record like 142-38), each re-checked with the indicator
// appended.

import {
  gameCardRecordSegments,
  gameCardRecordPortionText,
  gameCardRecordLineText,
  gameCardNoHistoryLineText,
  gameCardStreakSuffix,
  estimateGameCardLineWidthPx,
  GAME_CARD_LINE_MOBILE_BUDGET_PX,
  GAME_CARD_RECORD_PORTION_BUDGET_PX,
  GAME_CARD_NO_HISTORY_TEXT,
  type GameCardStreak,
} from "@/lib/game-card-record-line";

const winStreak = (count: number): GameCardStreak => ({ type: "WIN", count });
const lossStreak = (count: number): GameCardStreak => ({ type: "LOSS", count });

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
function checkLte(label: string, actual: number, limit: number) {
  const pass = actual <= limit;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> ${actual} <= ${limit}`);
  if (!pass) failures++;
}
function checkTrue(label: string, actual: boolean) {
  console.log(`${actual ? "PASS" : "FAIL"}: ${label}`);
  if (!actual) failures++;
}

const col = (wins: number, losses: number, pushes = 0) => ({
  wins,
  losses,
  pushes,
  winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0,
});
const N = 20;
const segsFor = (
  overall: ReturnType<typeof col>,
  league: ReturnType<typeof col>,
  last20: ReturnType<typeof col> | null,
  leagueName = "NCAAF"
) => gameCardRecordSegments({ overall, league, last20 }, leagueName, N);

// ---------------------------------------------------------------------------
console.log("########## exact format: above / below the Last-20 threshold ##########");
{
  const segs = segsFor(col(12, 3), col(8, 2), col(4, 1));
  check("labels: All / <league> / L20", segs.map((s) => s.label), ["All", "NCAAF", "L20"]);
  check("every segment carries a % (no parens)", segs.map((s) => s.pct), ["80%", "80%", "80%"]);
  check("only the league segment is emphasized", segs.map((s) => s.emphasized), [false, true, false]);
  check(
    "portion text - '|' between segments, no parens",
    gameCardRecordPortionText(segs),
    "All 12-3 80% | NCAAF 8-2 80% | L20 4-1 80%"
  );
  check(
    "full line - '·' before the first segment",
    gameCardRecordLineText("Team +3.5", segs),
    "Team +3.5 · All 12-3 80% | NCAAF 8-2 80% | L20 4-1 80%"
  );
}
{
  const segs = segsFor(col(6, 3), col(4, 2), null);
  check("below threshold: L20 segment absent", segs.map((s) => s.label), ["All", "NCAAF"]);
  check(
    "below threshold: line ends after the league segment, no '| L20' and no placeholder",
    gameCardRecordLineText("Team +3.5", segs),
    "Team +3.5 · All 6-3 67% | NCAAF 4-2 67%"
  );
}
check(
  "pushes render (12-3-1 style)",
  gameCardRecordPortionText(segsFor(col(3, 3, 1), col(2, 2, 1), null, "NBA")),
  "All 3-3-1 50% | NBA 2-2-1 50%"
);

// ---------------------------------------------------------------------------
console.log("\n##########  trailing 🔥/🧊 overall-streak indicator  ##########");
{
  // Below 2 in either direction -> nothing (line renders exactly as before).
  check("no streak: 1 win -> empty suffix", gameCardStreakSuffix(winStreak(1)), "");
  check("no streak: 1 loss -> empty suffix", gameCardStreakSuffix(lossStreak(1)), "");
  check("no streak: NONE -> empty suffix", gameCardStreakSuffix({ type: "NONE", count: 0 }), "");
  check("no streak: null -> empty suffix", gameCardStreakSuffix(null), "");
  check("no streak: undefined -> empty suffix", gameCardStreakSuffix(undefined), "");

  // 2+ win streak -> flame + count; 2+ loss streak -> ice cube + count.
  check("2 win streak -> 🔥2", gameCardStreakSuffix(winStreak(2)), "🔥2");
  check("3 win streak -> 🔥3", gameCardStreakSuffix(winStreak(3)), "🔥3");
  check("2 loss streak -> 🧊2", gameCardStreakSuffix(lossStreak(2)), "🧊2");
  check("6 loss streak -> 🧊6", gameCardStreakSuffix(lossStreak(6)), "🧊6");
  check("double-digit streak keeps the full count -> 🔥12", gameCardStreakSuffix(winStreak(12)), "🔥12");

  const segs = segsFor(col(12, 3), col(8, 2), col(4, 1));
  // Below 2 -> portion / line are byte-identical to the no-streak form.
  check(
    "portion with a sub-2 streak == portion with no streak",
    gameCardRecordPortionText(segs, winStreak(1)),
    gameCardRecordPortionText(segs)
  );
  check(
    "line with a sub-2 streak == line with no streak",
    gameCardRecordLineText("Team +3.5", segs, lossStreak(1)),
    gameCardRecordLineText("Team +3.5", segs)
  );

  // 2+ -> appended after the last segment, single space, at the very end.
  check(
    "win streak appends 🔥3 after L20",
    gameCardRecordPortionText(segs, winStreak(3)),
    "All 12-3 80% | NCAAF 8-2 80% | L20 4-1 80% 🔥3"
  );
  check(
    "loss streak appends 🧊2 after L20",
    gameCardRecordLineText("Team +3.5", segs, lossStreak(2)),
    "Team +3.5 · All 12-3 80% | NCAAF 8-2 80% | L20 4-1 80% 🧊2"
  );
  // Below the L20 threshold the indicator still lands at the end.
  check(
    "indicator appends after the league segment when L20 is dropped",
    gameCardRecordLineText("Team +3.5", segsFor(col(6, 3), col(4, 2), null), winStreak(4)),
    "Team +3.5 · All 6-3 67% | NCAAF 4-2 67% 🔥4"
  );

  // No category history: the streak is overall, not category-scoped, so it
  // shows on the "no history" line too - the whole reason this indicator
  // exists on every pick card, not just ones with a record.
  check(
    "streak shows on the no-category-history line",
    gameCardNoHistoryLineText("Team +3.5", winStreak(3)),
    "Team +3.5 · " + GAME_CARD_NO_HISTORY_TEXT + " 🔥3"
  );
  check(
    "no-history line without a streak is unchanged",
    gameCardNoHistoryLineText("Team +3.5", lossStreak(1)),
    "Team +3.5 · " + GAME_CARD_NO_HISTORY_TEXT
  );
  // Standalone (empty segments) - portion is just the suffix.
  check("empty segments + streak -> portion is the bare suffix", gameCardRecordPortionText([], winStreak(2)), "🔥2");
}

// ---------------------------------------------------------------------------
console.log("\n##########  mobile width: the common case is one row  ##########");
{
  const segsAbove = segsFor(col(12, 3), col(8, 2), col(4, 1));
  const segsBelow = segsFor(col(6, 3), col(4, 2), null);
  checkLte(
    "record portion fits its budget (shares a row with a normal bet detail)",
    estimateGameCardLineWidthPx(gameCardRecordPortionText(segsAbove)),
    GAME_CARD_RECORD_PORTION_BUDGET_PX
  );
  for (const bet of ["Team +3.5", "Over 55.5", "UNLV +7", "Bama ML", "Under 210.5", "Over 27.5 1H"]) {
    checkLte(
      `full line fits one row: "${bet}"`,
      estimateGameCardLineWidthPx(gameCardRecordLineText(bet, segsAbove)),
      GAME_CARD_LINE_MOBILE_BUDGET_PX
    );
  }
  checkLte(
    'below-threshold line fits with room to spare: "Team +3.5"',
    estimateGameCardLineWidthPx(gameCardRecordLineText("Team +3.5", segsBelow)),
    GAME_CARD_LINE_MOBILE_BUDGET_PX
  );
}

// ---------------------------------------------------------------------------
console.log("\n##########  mobile width: with the 🔥/🧊 indicator appended  ##########");
{
  // The PR #25 one-row check, re-run with BOTH indicator variants folded into
  // the width calculation.
  const segsAbove = segsFor(col(12, 3), col(8, 2), col(4, 1));
  const commonVariants: GameCardStreak[] = [winStreak(3), lossStreak(2)];

  for (const streak of commonVariants) {
    const suffix = gameCardStreakSuffix(streak);
    checkLte(
      `record portion + "${suffix}" still fits the portion budget`,
      estimateGameCardLineWidthPx(gameCardRecordPortionText(segsAbove, streak)),
      GAME_CARD_RECORD_PORTION_BUDGET_PX
    );
    // Short bet details - the common case - stay one row with the indicator.
    for (const bet of ["Team +3.5", "Over 55.5", "UNLV +7", "Bama ML"]) {
      checkLte(
        `full line + "${suffix}" fits one row: "${bet}"`,
        estimateGameCardLineWidthPx(gameCardRecordLineText(bet, segsAbove, streak)),
        GAME_CARD_LINE_MOBILE_BUDGET_PX
      );
    }
    // A medium bet detail that already sat near the edge in PR #25 can tip to
    // a SECOND row once the indicator is added - never more than 2, same
    // documented treatment as the long-team-name / 3-digit-record cases.
    const medium = estimateGameCardLineWidthPx(gameCardRecordLineText("Under 210.5", segsAbove, streak));
    checkTrue(
      `medium bet + "${suffix}" is at most 2 rows ("Under 210.5", ${medium}px)`,
      medium <= GAME_CARD_LINE_MOBILE_BUDGET_PX * 2
    );
  }

  // Worst case: a double-digit overall streak (10+ in a row - rare). The
  // extra digit alone can nudge even a short bet detail's full line ~2px past
  // the 300px budget; still one row for really short details, at most two for
  // the rest. The record portion still fits its own budget.
  const big = winStreak(12);
  checkLte(
    'record portion + "🔥12" fits the portion budget',
    estimateGameCardLineWidthPx(gameCardRecordPortionText(segsAbove, big)),
    GAME_CARD_RECORD_PORTION_BUDGET_PX
  );
  for (const bet of ["UNLV +7", "Bama ML"]) {
    checkLte(
      `full line + "🔥12" fits one row: "${bet}"`,
      estimateGameCardLineWidthPx(gameCardRecordLineText(bet, segsAbove, big)),
      GAME_CARD_LINE_MOBILE_BUDGET_PX
    );
  }
  for (const bet of ["Team +3.5", "Over 55.5", "Under 210.5"]) {
    const w = estimateGameCardLineWidthPx(gameCardRecordLineText(bet, segsAbove, big));
    checkTrue(`full line + "🔥12" is at most 2 rows: "${bet}" (${w}px)`, w <= GAME_CARD_LINE_MOBILE_BUDGET_PX * 2);
  }

  // The no-category-history line + indicator - also at most one extra row.
  for (const bet of ["Team +3.5", "Washington State -7"]) {
    const w = estimateGameCardLineWidthPx(gameCardNoHistoryLineText(bet, lossStreak(6)));
    checkTrue(`no-history line + "🧊6" is at most 2 rows: "${bet}" (${w}px)`, w <= GAME_CARD_LINE_MOBILE_BUDGET_PX * 2);
  }
  checkLte(
    'no-history line + "🔥3" fits one row for a short bet: "Team +3.5"',
    estimateGameCardLineWidthPx(gameCardNoHistoryLineText("Team +3.5", winStreak(3))),
    GAME_CARD_LINE_MOBILE_BUDGET_PX
  );
}

// ---------------------------------------------------------------------------
console.log("\n##########  stress case 1: a 3-digit lifetime record (142-38)  ##########");
{
  const segs3 = segsFor(col(142, 38), col(98, 22), col(12, 8));
  check(
    "renders cleanly - no overflow of the record shape",
    gameCardRecordPortionText(segs3),
    "All 142-38 79% | NCAAF 98-22 82% | L20 12-8 60%"
  );
  checkLte(
    "record portion still fits its budget even at 3 digits",
    estimateGameCardLineWidthPx(gameCardRecordPortionText(segs3)),
    GAME_CARD_RECORD_PORTION_BUDGET_PX
  );
  checkLte(
    'full line fits one row with a short bet detail: "UNLV +7"',
    estimateGameCardLineWidthPx(gameCardRecordLineText("UNLV +7", segs3)),
    GAME_CARD_LINE_MOBILE_BUDGET_PX
  );
  // A 3-digit record + a MEDIUM bet detail is right at the edge - it wraps to
  // a SECOND row on the narrower mainstream phones. Documented, not a
  // regression: the verbose line it replaces wrapped to 2-3 rows for EVERY
  // pick, and this only happens for a capper with 180+ graded picks in ONE
  // category (a very prolific single-market specialist).
  const mediumFull = estimateGameCardLineWidthPx(gameCardRecordLineText("Over 210.5", segs3));
  checkTrue(
    `3-digit + medium bet ("Over 210.5") wraps to exactly 2 rows (${mediumFull}px, budget ${GAME_CARD_LINE_MOBILE_BUDGET_PX})`,
    mediumFull > GAME_CARD_LINE_MOBILE_BUDGET_PX && mediumFull <= GAME_CARD_LINE_MOBILE_BUDGET_PX * 2
  );
  checkLte(
    "3-digit below the L20 threshold fits one row again (L20 dropped)",
    estimateGameCardLineWidthPx(gameCardRecordLineText("Team +3.5", segsFor(col(142, 38), col(98, 22), null))),
    GAME_CARD_LINE_MOBILE_BUDGET_PX
  );
}

// ---------------------------------------------------------------------------
console.log("\n##########  stress case 2: a long college team name  ##########");
{
  const segs = segsFor(col(12, 3), col(8, 2), col(4, 1));
  const full = estimateGameCardLineWidthPx(gameCardRecordLineText("Washington State -7", segs));
  checkTrue(
    `"Washington State -7" wraps to exactly 2 rows (${full}px) - same as PR #25, same as the verbose line for every pick`,
    full > GAME_CARD_LINE_MOBILE_BUDGET_PX && full <= GAME_CARD_LINE_MOBILE_BUDGET_PX * 2
  );
  checkLte(
    'the same pick fits one row below the L20 threshold: "Washington State -7"',
    estimateGameCardLineWidthPx(gameCardRecordLineText("Washington State -7", segsFor(col(6, 3), col(4, 2), null))),
    GAME_CARD_LINE_MOBILE_BUDGET_PX
  );
}

// ---------------------------------------------------------------------------
console.log("\n##########  a dense 9-pick card stays compact  ##########");
{
  const above = segsFor(col(11, 1), col(7, 1), col(5, 3));
  const below = segsFor(col(4, 2), col(2, 1), null);
  const stacked = [
    { bet: "UNLV +7", segs: above },
    { bet: "Over 55.5", segs: above },
    { bet: "Under 55.5", segs: below },
    { bet: "UNLV ML", segs: below },
    { bet: "Over 27.5 1H", segs: above },
    { bet: "UNLV 1H +3.5", segs: below },
    { bet: "Washington State -7", segs: above },
    { bet: "Washington State ML", segs: below },
    { bet: "Bama TT o24.5", segs: above },
  ];
  const portionOverflows = stacked.filter(
    (p) => estimateGameCardLineWidthPx(gameCardRecordPortionText(p.segs)) > GAME_CARD_RECORD_PORTION_BUDGET_PX
  );
  check("no pick's record portion overflows (each stays one row)", portionOverflows.map((p) => p.bet), []);
  const oneRow = stacked.filter(
    (p) => estimateGameCardLineWidthPx(gameCardRecordLineText(p.bet, p.segs)) <= GAME_CARD_LINE_MOBILE_BUDGET_PX
  );
  checkTrue(`at least 7 of 9 dense-card picks are a clean single row (got ${oneRow.length})`, oneRow.length >= 7);

  // Same dense card, now every capper on a streak (alternating 🔥/🧊): the
  // record portions still don't overflow, and the majority of full lines are
  // still one row.
  const withStreak = stacked.map((p, i) => ({ ...p, streak: i % 2 === 0 ? winStreak(3) : lossStreak(2) }));
  const portionOverflowsStreak = withStreak.filter(
    (p) => estimateGameCardLineWidthPx(gameCardRecordPortionText(p.segs, p.streak)) > GAME_CARD_RECORD_PORTION_BUDGET_PX
  );
  check("with indicators, no record portion overflows", portionOverflowsStreak.map((p) => p.bet), []);
  const oneRowStreak = withStreak.filter(
    (p) => estimateGameCardLineWidthPx(gameCardRecordLineText(p.bet, p.segs, p.streak)) <= GAME_CARD_LINE_MOBILE_BUDGET_PX
  );
  checkTrue(
    `with indicators, at least 6 of 9 dense-card picks are still one row (got ${oneRowStreak.length})`,
    oneRowStreak.length >= 6
  );
}

// ---------------------------------------------------------------------------
console.log("\n##########  still shorter than the verbose line it replaces  ##########");
{
  const condensed = gameCardRecordPortionText(segsFor(col(12, 3), col(8, 2), col(4, 1)));
  const verbose = "12-3 (80%) all-time | 4-1 (80%) last 20 on underdog spread picks";
  checkTrue(
    `condensed portion (${condensed.length} chars) is shorter than the old verbose portion (${verbose.length})`,
    condensed.length < verbose.length
  );
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
