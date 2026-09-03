// Proof that CFL full-game grading works with no CFL-specific code - run with:
//   npx tsx src/server/data/cfl-grading-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// The claim (from the CFL grading investigation): standard CFL moneyline /
// spread / total grading is score comparison only, identical to NFL/NHL. The
// score source (The Odds API /scores) reports the FINAL score, which already
// includes rouges (the CFL-only 1-point play) and overtime - exactly what
// sportsbooks grade against - so nothing special is needed in gradePick.
//
// The two CFL edge cases, analogous to NHL's OT/shootout puck-line test:
//   1. A rouge-decided 1-point margin: a spread of +/-1 PUSHes, +/-2.5 flips.
//      Rouges make 1-point CFL finals common - three happened in 2022 alone.
//   2. A TIE: CFL regular-season games can end level (still tied after two OT
//      possessions). Rare, but real - and the one grading sport where a
//      MONEYLINE PUSH from a genuine tie occurs (NFL/NHL effectively never do).
//
// Scores are real 2022 CFL finals (the tie is constructed - none in 2022):
//   Toronto Argonauts 20, Montreal Alouettes 19   (rouge-territory 1-pt game)
//   BC Lions 41, Calgary Stampeders 40             (1-pt game, total 81 - CFL
//                                                   is high-scoring)

import { gradePick, resolveOutcome } from "./grading";
import type { GameResult } from "@prisma/client";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${expected} actual=${actual}`);
  if (!pass) failures++;
}

// ============================================================
// MONEYLINE
// ============================================================

expect(
  "ML: home (Argos) won 20-19 -> WIN",
  gradePick("MONEYLINE", "Argonauts ML", null, "Toronto Argonauts", "Montreal Alouettes", 20, 19, "HOME"),
  "WIN"
);
expect(
  "ML: away (Alouettes) lost 19-20 -> LOSS",
  gradePick("MONEYLINE", "Alouettes ML", null, "Toronto Argonauts", "Montreal Alouettes", 20, 19, "AWAY"),
  "LOSS"
);
expect(
  "ML: a genuine CFL tie (27-27) -> PUSH",
  gradePick("MONEYLINE", "Elks ML", null, "Ottawa Redblacks", "Edmonton Elks", 27, 27, "AWAY"),
  "PUSH"
);

// ============================================================
// SPREAD - the rouge/1-point edge case
// ============================================================

expect(
  "spread: Argos -1 in a 1-point win (20-19) -> PUSH",
  gradePick("SPREAD", "Argonauts -1", -1, "Toronto Argonauts", "Montreal Alouettes", 20, 19, "HOME"),
  "PUSH"
);
expect(
  "spread: Alouettes +1 in a 1-point loss (19-20) -> PUSH",
  gradePick("SPREAD", "Alouettes +1", 1, "Toronto Argonauts", "Montreal Alouettes", 20, 19, "AWAY"),
  "PUSH"
);
expect(
  "spread: Argos -2.5 in a 1-point win -> LOSS (a rouge is the difference between covering and not)",
  gradePick("SPREAD", "Argonauts -2.5", -2.5, "Toronto Argonauts", "Montreal Alouettes", 20, 19, "HOME"),
  "LOSS"
);
expect(
  "spread: Alouettes +2.5 in a 1-point loss -> WIN",
  gradePick("SPREAD", "Alouettes +2.5", 2.5, "Toronto Argonauts", "Montreal Alouettes", 20, 19, "AWAY"),
  "WIN"
);
expect(
  "spread: Argos -1.5 in a 1-point win -> LOSS (didn't cover the half-point)",
  gradePick("SPREAD", "Argonauts -1.5", -1.5, "Toronto Argonauts", "Montreal Alouettes", 20, 19, "HOME"),
  "LOSS"
);
// A CFL tie against a pick'em spread also pushes.
expect(
  "spread: home -0 (pick'em) in a 27-27 tie -> PUSH",
  gradePick("SPREAD", "home -0", 0, "Ottawa Redblacks", "Edmonton Elks", 27, 27, "HOME"),
  "PUSH"
);

// ============================================================
// TOTAL - CFL is high-scoring (rouges, wide field, 3 downs -> more possessions)
// ============================================================

expect(
  "total: BC/Calgary 41+40=81, over 78.5 -> WIN",
  gradePick("TOTAL", "over 78.5", 78.5, "Calgary Stampeders", "BC Lions", 40, 41, null),
  "WIN"
);
expect(
  "total: BC/Calgary 81, under 78.5 -> LOSS",
  gradePick("TOTAL", "under 78.5", 78.5, "Calgary Stampeders", "BC Lions", 40, 41, null),
  "LOSS"
);
expect(
  "total: 40+40=80, a single rouge would be the difference vs an 80.0 line -> under is a PUSH at 80",
  gradePick("TOTAL", "under 80", 80, "Calgary Stampeders", "BC Lions", 40, 40, null),
  "PUSH"
);
expect(
  "total: that same 80 vs over 79.5 -> WIN (the rouge tipped it)",
  gradePick("TOTAL", "over 79.5", 79.5, "Calgary Stampeders", "BC Lions", 40, 40, null),
  "WIN"
);

// ============================================================
// resolveOutcome: a FULL_GAME CFL pick flows through the generic score path.
// ============================================================

const rougeGame = {
  sportKey: "americanfootball_cfl",
  externalId: "cfl-evt-final-1",
  homeTeam: "Toronto Argonauts",
  awayTeam: "Montreal Alouettes",
  homeScore: 20,
  awayScore: 19,
  firstFiveHomeScore: null,
  firstFiveAwayScore: null,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
} as unknown as GameResult;

expect(
  "resolveOutcome: FULL_GAME ML on the 1-point winner -> WIN",
  resolveOutcome(
    { betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Argonauts ML", homeTeam: "Toronto Argonauts", line: null, pickedSide: "HOME" },
    rougeGame
  ),
  "WIN"
);
expect(
  "resolveOutcome: FULL_GAME spread, Alouettes +2.5 in a 1-point loss -> WIN",
  resolveOutcome(
    { betType: "SPREAD", period: "FULL_GAME", betDetail: "Alouettes +2.5", homeTeam: "Toronto Argonauts", line: 2.5, pickedSide: "AWAY" },
    rougeGame
  ),
  "WIN"
);
expect(
  "resolveOutcome: a FIRST_HALF CFL pick has no period source -> null (stays pending)",
  resolveOutcome(
    { betType: "MONEYLINE", period: "FIRST_HALF", betDetail: "Argonauts ML", homeTeam: "Toronto Argonauts", line: null, pickedSide: "HOME" },
    rougeGame
  ),
  null
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
