// Proof that NHL full-game grading works with no NHL-specific code - run with:
//   npx tsx src/server/data/nhl-grading-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// The claim under test (from the NHL grading investigation): a standard NHL
// moneyline / puck line / total grade is score-comparison only, identical to
// NBA, because ESPN's `competitor.score` is the FINAL score including overtime
// AND the shootout deciding goal - which is exactly what every US sportsbook
// grades NHL sides and totals against. So the OT/shootout "wrinkle" needs zero
// special handling in gradePick or resolveOutcome.
//
// Scores below are real 2025-26 games captured from ESPN's NHL scoreboard:
//   - regulation : Winnipeg Jets 3, St. Louis Blues 2  (period 3, "Final")
//   - overtime   : Philadelphia Flyers 2, Boston Bruins 1  (1-1 after regulation,
//                  "Final/OT" - final margin exactly 1)
//   - shootout   : Buffalo Sabres 3, Dallas Stars 4  (3-3 after regulation,
//                  Dallas won the shootout, "Final/SO" - Dallas' score carries
//                  the +1 shootout goal, final margin exactly 1)

import { gradePick, resolveOutcome } from "./grading";
import type { GameResult } from "@prisma/client";

let failures = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${expected} actual=${actual}`);
  if (!pass) failures++;
}

// ============================================================
// MONEYLINE - including a shootout win (SO winner wins the ML)
// ============================================================

expect(
  "regulation ML: home favorite (Jets) won 3-2 -> WIN",
  gradePick("MONEYLINE", "Jets ML", null, "Winnipeg Jets", "St. Louis Blues", 3, 2, "HOME"),
  "WIN"
);
expect(
  "regulation ML: away side (Blues) lost 2-3 -> LOSS",
  gradePick("MONEYLINE", "Blues ML", null, "Winnipeg Jets", "St. Louis Blues", 3, 2, "AWAY"),
  "LOSS"
);
expect(
  "overtime ML: home (Flyers) won 2-1 in OT -> WIN",
  gradePick("MONEYLINE", "Flyers ML", null, "Philadelphia Flyers", "Boston Bruins", 2, 1, "HOME"),
  "WIN"
);
expect(
  "shootout ML: away (Stars) won the shootout, final 4-3 -> WIN",
  gradePick("MONEYLINE", "Stars ML", null, "Buffalo Sabres", "Dallas Stars", 3, 4, "AWAY"),
  "WIN"
);
expect(
  "shootout ML: home (Sabres) lost the shootout, final 3-4 -> LOSS",
  gradePick("MONEYLINE", "Sabres ML", null, "Buffalo Sabres", "Dallas Stars", 3, 4, "HOME"),
  "LOSS"
);
// NHL has no ties - a MONEYLINE grade never returns PUSH for a real final.

// ============================================================
// PUCK LINE (SPREAD, almost always +/-1.5)
// The edge case: in every OT/shootout game the final margin is exactly 1,
// so -1.5 on the winner MUST lose and +1.5 on the loser MUST win.
// ============================================================

expect(
  "puck line: Jets -1.5, won by exactly 1 (3-2) -> LOSS (didn't cover)",
  gradePick("SPREAD", "Jets -1.5", -1.5, "Winnipeg Jets", "St. Louis Blues", 3, 2, "HOME"),
  "LOSS"
);
expect(
  "puck line: Blues +1.5, lost by exactly 1 (2-3) -> WIN (covered)",
  gradePick("SPREAD", "Blues +1.5", 1.5, "Winnipeg Jets", "St. Louis Blues", 3, 2, "AWAY"),
  "WIN"
);
expect(
  "puck line OT: Flyers -1.5, OT win by 1 (2-1) -> LOSS",
  gradePick("SPREAD", "Flyers -1.5", -1.5, "Philadelphia Flyers", "Boston Bruins", 2, 1, "HOME"),
  "LOSS"
);
expect(
  "puck line OT: Bruins +1.5, OT loss by 1 (1-2) -> WIN",
  gradePick("SPREAD", "Bruins +1.5", 1.5, "Philadelphia Flyers", "Boston Bruins", 2, 1, "AWAY"),
  "WIN"
);
expect(
  "puck line shootout: Stars -1.5, SO win counts as a 1-goal win (4-3) -> LOSS",
  gradePick("SPREAD", "Stars -1.5", -1.5, "Buffalo Sabres", "Dallas Stars", 3, 4, "AWAY"),
  "LOSS"
);
expect(
  "puck line shootout: Sabres +1.5, SO loss (3-4) -> WIN",
  gradePick("SPREAD", "Sabres +1.5", 1.5, "Buffalo Sabres", "Dallas Stars", 3, 4, "HOME"),
  "WIN"
);
// A regulation blowout still covers -1.5 the ordinary way.
expect(
  "puck line: home -1.5 wins by 2 (4-2) -> WIN",
  gradePick("SPREAD", "home -1.5", -1.5, "Winnipeg Jets", "St. Louis Blues", 4, 2, "HOME"),
  "WIN"
);
expect(
  "puck line PUSH is impossible at 1.5, but an integer line can push (home -1, win by 1) -> PUSH",
  gradePick("SPREAD", "home -1", -1, "Winnipeg Jets", "St. Louis Blues", 3, 2, "HOME"),
  "PUSH"
);

// ============================================================
// TOTAL (goals) - includes OT goals and the shootout deciding goal
// ============================================================

expect(
  "total: Jets/Blues 3+2=5, over 5.5 -> LOSS",
  gradePick("TOTAL", "over 5.5", 5.5, "Winnipeg Jets", "St. Louis Blues", 3, 2, null),
  "LOSS"
);
expect(
  "total: Jets/Blues 3+2=5, under 5.5 -> WIN",
  gradePick("TOTAL", "under 5.5", 5.5, "Winnipeg Jets", "St. Louis Blues", 3, 2, null),
  "WIN"
);
expect(
  "total: shootout game 3+4=7 (SO goal included), over 6.5 -> WIN",
  gradePick("TOTAL", "over 6.5", 6.5, "Buffalo Sabres", "Dallas Stars", 3, 4, null),
  "WIN"
);
expect(
  "total: shootout game 3+4=7, under 6.5 -> LOSS",
  gradePick("TOTAL", "under 6.5", 6.5, "Buffalo Sabres", "Dallas Stars", 3, 4, null),
  "LOSS"
);
expect(
  "total PUSH: OT game 2+1=3, over 3.0 -> PUSH",
  gradePick("TOTAL", "over 3", 3, "Philadelphia Flyers", "Boston Bruins", 2, 1, null),
  "PUSH"
);

// ============================================================
// resolveOutcome: a FULL_GAME NHL pick flows through the generic path
// (game.homeScore / game.awayScore), no first-half / period source needed.
// ============================================================

const shootoutGame = {
  sportKey: "icehockey_nhl",
  externalId: "401803999",
  homeTeam: "Buffalo Sabres",
  awayTeam: "Dallas Stars",
  homeScore: 3,
  awayScore: 4,
  firstFiveHomeScore: null,
  firstFiveAwayScore: null,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
} as unknown as GameResult;

expect(
  "resolveOutcome: FULL_GAME ML on the shootout winner (Stars) -> WIN",
  resolveOutcome(
    { betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Stars ML", homeTeam: "Buffalo Sabres", line: null, pickedSide: "AWAY" },
    shootoutGame
  ),
  "WIN"
);
expect(
  "resolveOutcome: FULL_GAME puck line, Sabres +1.5 in a SO loss -> WIN",
  resolveOutcome(
    { betType: "SPREAD", period: "FULL_GAME", betDetail: "Sabres +1.5", homeTeam: "Buffalo Sabres", line: 1.5, pickedSide: "HOME" },
    shootoutGame
  ),
  "WIN"
);
expect(
  "resolveOutcome: a FIRST_HALF NHL pick has no period source -> null (stays pending), not a wrong grade",
  resolveOutcome(
    { betType: "MONEYLINE", period: "FIRST_HALF", betDetail: "Stars ML", homeTeam: "Buffalo Sabres", line: null, pickedSide: "AWAY" },
    shootoutGame
  ),
  null
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
