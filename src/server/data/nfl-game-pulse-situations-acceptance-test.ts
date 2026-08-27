// Correctness proof for the situational-question evaluators in
// nfl-game-pulse-situations.ts, run with:
//   npx tsx src/server/data/nfl-game-pulse-situations-acceptance-test.ts
// Not a general test suite (see grading-correctness-acceptance-test.ts for
// the same pattern - this repo has no test runner configured).
//
// Fixtures here are small hand-constructed edge cases (ties, missing data,
// margin-threshold boundaries) chosen to exercise specific branches -
// deliberately synthetic, not pulled from a real game. Real-data
// verification (does this logic behave sanely against actual finished NFL
// games' captured quarters/scoringPlays/turnovers) was done separately
// against 8 real 2026 preseason games - see the NFL Game Pulse data-
// feasibility investigation and build session, not checked in here, same
// reasoning as game-pulse-situations-acceptance-test.ts's own real-data note.
//
// Exits non-zero if any assertion fails.
import { NFL_SITUATIONAL_QUESTIONS, type NflSituationalQuestionKey, type NflGameRawFacts } from "./nfl-game-pulse-situations";

let failures = 0;

function question(key: NflSituationalQuestionKey) {
  const q = NFL_SITUATIONAL_QUESTIONS.find((q) => q.key === key);
  if (!q) throw new Error("missing question " + key);
  return q;
}

function expect(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${expected} actual=${actual}`);
  if (!pass) failures++;
}

const NO_DATA: NflGameRawFacts = { quarters: null, scoringPlays: null, homeTurnovers: null, awayTurnovers: null };

// ---- scoredFirst ----

expect("scoredFirst: no scoringPlays data at all - null", question("scoredFirst").evaluate(NO_DATA), null);

expect(
  "scoredFirst: genuinely scoreless game (empty array, not null) - null",
  question("scoredFirst").evaluate({ ...NO_DATA, scoringPlays: [] }),
  null
);

expect(
  "scoredFirst: away's running score is the first to leave 0-0 - away",
  question("scoredFirst").evaluate({ ...NO_DATA, scoringPlays: [{ home: 0, away: 7 }, { home: 7, away: 7 }] }),
  "away"
);

expect(
  "scoredFirst: home's running score is the first to leave 0-0 - home",
  question("scoredFirst").evaluate({ ...NO_DATA, scoringPlays: [{ home: 3, away: 0 }, { home: 3, away: 7 }] }),
  "home"
);

// ---- leadingAtHalftime ----

expect("leadingAtHalftime: no quarters data - null", question("leadingAtHalftime").evaluate(NO_DATA), null);

expect(
  "leadingAtHalftime: only 1 quarter captured so far - null, can't sum Q1+Q2",
  question("leadingAtHalftime").evaluate({ ...NO_DATA, quarters: [{ home: 7, away: 0 }] }),
  null
);

expect(
  "leadingAtHalftime: home ahead after Q1+Q2 - home",
  question("leadingAtHalftime").evaluate({ ...NO_DATA, quarters: [{ home: 7, away: 0 }, { home: 3, away: 3 }] }),
  "home"
);

expect(
  "leadingAtHalftime: tied at the half - null, not an arbitrary pick",
  question("leadingAtHalftime").evaluate({ ...NO_DATA, quarters: [{ home: 7, away: 7 }, { home: 0, away: 0 }] }),
  null
);

// ---- trailingEntering4th ----

expect(
  "trailingEntering4th: only 2 quarters captured - null, needs Q1+Q2+Q3",
  question("trailingEntering4th").evaluate({ ...NO_DATA, quarters: [{ home: 7, away: 0 }, { home: 0, away: 3 }] }),
  null
);

expect(
  "trailingEntering4th: away is behind through 3 quarters - away (the mirror of leadingAtHalftime-style checks, not the leader)",
  question("trailingEntering4th").evaluate({
    ...NO_DATA,
    quarters: [{ home: 7, away: 0 }, { home: 3, away: 3 }, { home: 0, away: 0 }],
  }),
  "away"
);

expect(
  "trailingEntering4th: tied through 3 quarters - null",
  question("trailingEntering4th").evaluate({
    ...NO_DATA,
    quarters: [{ home: 7, away: 7 }, { home: 3, away: 3 }, { home: 0, away: 0 }],
  }),
  null
);

// ---- wonTurnoverBattle ----

expect(
  "wonTurnoverBattle: one side's turnovers missing - null",
  question("wonTurnoverBattle").evaluate({ ...NO_DATA, homeTurnovers: 1, awayTurnovers: null }),
  null
);

expect(
  "wonTurnoverBattle: fewer turnovers wins - home had 1, away had 3",
  question("wonTurnoverBattle").evaluate({ ...NO_DATA, homeTurnovers: 1, awayTurnovers: 3 }),
  "home"
);

expect(
  "wonTurnoverBattle: equal turnovers - null, no winner",
  question("wonTurnoverBattle").evaluate({ ...NO_DATA, homeTurnovers: 2, awayTurnovers: 2 }),
  null
);

expect(
  "wonTurnoverBattle: both sides had zero turnovers - still null (equal, not a home win by default)",
  question("wonTurnoverBattle").evaluate({ ...NO_DATA, homeTurnovers: 0, awayTurnovers: 0 }),
  null
);

// ---- ledByDoubleDigits ----

expect("ledByDoubleDigits: no scoringPlays data - null", question("ledByDoubleDigits").evaluate(NO_DATA), null);

expect(
  "ledByDoubleDigits: margin never reaches 10 - null",
  question("ledByDoubleDigits").evaluate({ ...NO_DATA, scoringPlays: [{ home: 7, away: 0 }, { home: 7, away: 7 }, { home: 14, away: 7 }] }),
  null
);

expect(
  "ledByDoubleDigits: margin boundary - exactly 10 counts (>=, not >)",
  question("ledByDoubleDigits").evaluate({ ...NO_DATA, scoringPlays: [{ home: 10, away: 0 }] }),
  "home"
);

expect(
  "ledByDoubleDigits: margin of 9 does not count",
  question("ledByDoubleDigits").evaluate({ ...NO_DATA, scoringPlays: [{ home: 9, away: 0 }] }),
  null
);

expect(
  "ledByDoubleDigits: away reaches double digits - away",
  question("ledByDoubleDigits").evaluate({ ...NO_DATA, scoringPlays: [{ home: 0, away: 3 }, { home: 0, away: 13 }] }),
  "away"
);

expect(
  "ledByDoubleDigits: a full comeback - home reaches +10 first, away catches up and later also reaches +10 - resolves to whichever hit the threshold FIRST chronologically (home), same convention as MLB's bigInning",
  question("ledByDoubleDigits").evaluate({
    ...NO_DATA,
    scoringPlays: [{ home: 10, away: 0 }, { home: 10, away: 10 }, { home: 10, away: 20 }],
  }),
  "home"
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
