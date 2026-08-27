// Correctness proof for computeGamePulseFromRates' tally/threshold logic in
// game-pulse.ts, run with:
//   npx tsx src/server/data/game-pulse-acceptance-test.ts
// Not a general test suite (see grading-correctness-acceptance-test.ts for
// the same pattern - this repo has no test runner configured).
//
// Every fixture below - both the rate inputs and the innings arrays - is
// hand-constructed synthetic data, not pulled from a real game. The
// situation-detection half of this pipeline (which questions are even in
// play for a given set of innings) is exactly what
// game-pulse-situations-acceptance-test.ts and its separate real-data run
// already verified against genuine live MLB games; this file only needs to
// exercise the NEW logic on top of that - the tally/threshold arithmetic -
// so synthetic, exact-boundary-value fixtures are more useful here than
// real ones would be.
//
// Exits non-zero if any assertion fails.
import { computeGamePulseFromRates } from "./game-pulse";
import { SITUATIONAL_QUESTIONS, type SituationalQuestionKey, type SituationalRatesByQuestion } from "./game-pulse-situations";

let failures = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}`);
  if (!pass) {
    console.log("  expected:", JSON.stringify(expected));
    console.log("  actual:  ", JSON.stringify(actual));
    failures++;
  }
}

// All-zero rates (every question ineligible - either team) as a base to
// override per test case, so each case only has to specify what it cares
// about.
function ratesWith(overrides: Partial<Record<SituationalQuestionKey, { wins: number; total: number; winPct: number }>>): SituationalRatesByQuestion {
  const base = {} as SituationalRatesByQuestion;
  for (const q of SITUATIONAL_QUESTIONS) base[q.key] = { wins: 0, total: 0, winPct: 0 };
  return { ...base, ...overrides };
}

const NONE = ratesWith({});

// ---- Synthetic: scoreless through 7, one run in the 8th - every question
// resolves to null (nobody's led, trailed, or had a big inning) regardless
// of what rates are supplied ----
const scorelessGame = { homeTeam: "Home Team", awayTeam: "Away Team", innings: [
  { num: 1, home: { runs: 0 }, away: { runs: 0 } },
  { num: 2, home: { runs: 0 }, away: { runs: 0 } },
  { num: 3, home: { runs: 0 }, away: { runs: 0 } },
  { num: 4, home: { runs: 0 }, away: { runs: 0 } },
  { num: 5, home: { runs: 0 }, away: { runs: 0 } },
  { num: 6, home: { runs: 0 }, away: { runs: 0 } },
  { num: 7, home: { runs: 0 }, away: { runs: 0 } },
  { num: 8, home: { runs: 1 }, away: { runs: 0 } },
] };

expect(
  "scoreless-through-7 game with no historical data at all: no badge (nothing eligible)",
  computeGamePulseFromRates(scorelessGame, NONE, NONE),
  null
);

// ---- Synthetic but game-shaped: home leads after 5 and after 7, home also
// scored first and had a big inning - a team sweeping every question ----
const homeSweepGame = { homeTeam: "Home Team", awayTeam: "Away Team", innings: [
  { num: 1, home: { runs: 4 }, away: { runs: 0 } },
  { num: 2, home: { runs: 0 }, away: { runs: 0 } },
  { num: 3, home: { runs: 0 }, away: { runs: 0 } },
  { num: 4, home: { runs: 0 }, away: { runs: 0 } },
  { num: 5, home: { runs: 0 }, away: { runs: 0 } },
  { num: 6, home: { runs: 0 }, away: { runs: 0 } },
  { num: 7, home: { runs: 0 }, away: { runs: 0 } },
] };
// scoredFirst -> home, leadingAfter5 -> home, leadingAfter7 -> home,
// bigInning -> home (4 in inning 1), trailingAfter7 -> null (nobody's behind
// from home's perspective in a losing sense - away is behind, but that's a
// DIFFERENT credited side; away's rate isn't part of this fixture and won't
// be eligible under NONE)

expect(
  "home holds all 4 evaluable questions, but zero historical sample for anyone: still no badge - sample floor blocks everything",
  computeGamePulseFromRates(homeSweepGame, NONE, NONE),
  null
);

expect(
  "home holds all 4 questions, all with strong (>=58%) and sufficient (>=10 games) rates: badge fires for home with 4 evidence entries",
  computeGamePulseFromRates(
    homeSweepGame,
    ratesWith({
      scoredFirst: { wins: 12, total: 15, winPct: 80 },
      leadingAfter5: { wins: 8, total: 10, winPct: 80 },
      leadingAfter7: { wins: 18, total: 20, winPct: 90 },
      bigInning: { wins: 7, total: 10, winPct: 70 },
    }),
    NONE
  ),
  { leaningTeam: "Home Team", margin: 4, evidence: [
    { questionKey: "leadingAfter7", label: "lead after 7", subjectTeam: "Home Team", winPct: 90, sampleSize: 20 },
    { questionKey: "scoredFirst", label: "score first", subjectTeam: "Home Team", winPct: 80, sampleSize: 15 },
    { questionKey: "leadingAfter5", label: "lead after 5", subjectTeam: "Home Team", winPct: 80, sampleSize: 10 },
    { questionKey: "bigInning", label: "have a 3+ run inning", subjectTeam: "Home Team", winPct: 70, sampleSize: 10 },
  ] }
);

expect(
  "same game, but only 1 question clears both floors: no badge - below BADGE_MIN_ELIGIBLE",
  computeGamePulseFromRates(
    homeSweepGame,
    ratesWith({ scoredFirst: { wins: 12, total: 15, winPct: 80 } }),
    NONE
  ),
  null
);

expect(
  "same game, exactly 2 questions clear both floors and agree: badge fires (meets margin=2, min-eligible=2 exactly)",
  computeGamePulseFromRates(
    homeSweepGame,
    ratesWith({
      scoredFirst: { wins: 12, total: 15, winPct: 80 },
      leadingAfter5: { wins: 8, total: 10, winPct: 80 },
    }),
    NONE
  ) !== null,
  true
);

expect(
  "sample floor: 9 historical games (one below the 10-game floor) does not count even at a strong win%",
  computeGamePulseFromRates(
    homeSweepGame,
    ratesWith({
      scoredFirst: { wins: 9, total: 9, winPct: 100 },
      leadingAfter5: { wins: 8, total: 10, winPct: 80 },
    }),
    NONE
  ),
  null // only 1 question (leadingAfter5) actually clears the floor - below BADGE_MIN_ELIGIBLE
);

expect(
  "skew floor: a 55% win rate (inside the 42-58 coin-flip band) does not count even with plenty of sample",
  computeGamePulseFromRates(
    homeSweepGame,
    ratesWith({
      scoredFirst: { wins: 55, total: 100, winPct: 55 },
      leadingAfter5: { wins: 8, total: 10, winPct: 80 },
    }),
    NONE
  ),
  null
);

expect(
  "skew floor boundary: exactly 58% counts as eligible (>=, not >)",
  computeGamePulseFromRates(
    homeSweepGame,
    ratesWith({
      scoredFirst: { wins: 58, total: 100, winPct: 58 },
      leadingAfter5: { wins: 8, total: 10, winPct: 80 },
    }),
    NONE
  ) !== null,
  true
);

// ---- The "opponent" branch: a team's own bad history (<=42%) in a
// situation THEY hold credits the OTHER team, not them ----
expect(
  "home holds leadingAfter5 and leadingAfter7, but home historically has a LOW win% in both (<=42) - both credit away instead, badge leans away even though away never held anything directly",
  computeGamePulseFromRates(
    homeSweepGame,
    ratesWith({
      leadingAfter5: { wins: 3, total: 15, winPct: 20 },
      leadingAfter7: { wins: 4, total: 20, winPct: 20 },
    }),
    NONE
  ),
  { leaningTeam: "Away Team", margin: 2, evidence: [
    { questionKey: "leadingAfter5", label: "lead after 5", subjectTeam: "Home Team", winPct: 20, sampleSize: 15 },
    { questionKey: "leadingAfter7", label: "lead after 7", subjectTeam: "Home Team", winPct: 20, sampleSize: 20 },
  ] }
);

// ---- Evidence cap: more than 4 eligible-and-agreeing questions still only
// returns the 4 strongest ----
const trailingHomeGame = { homeTeam: "Home Team", awayTeam: "Away Team", innings: [
  { num: 1, home: { runs: 0 }, away: { runs: 4 } },
  { num: 2, home: { runs: 0 }, away: { runs: 0 } },
  { num: 3, home: { runs: 0 }, away: { runs: 0 } },
  { num: 4, home: { runs: 0 }, away: { runs: 0 } },
  { num: 5, home: { runs: 0 }, away: { runs: 0 } },
  { num: 6, home: { runs: 0 }, away: { runs: 0 } },
  { num: 7, home: { runs: 0 }, away: { runs: 0 } },
] };
// away holds: scoredFirst, leadingAfter5, leadingAfter7, bigInning (all 4) -
// home holds: trailingAfter7 (the 5th and only remaining question)
expect(
  "5 questions all eligible and agreeing (4 credited to away directly + home's own bad trailingAfter7 rate also credits away): evidence caps at the 4 strongest by |winPct-50|, not all 5",
  computeGamePulseFromRates(
    trailingHomeGame,
    ratesWith({ trailingAfter7: { wins: 2, total: 20, winPct: 10 } }), // home's own rate when trailing after 7 - very low, credits away
    ratesWith({
      scoredFirst: { wins: 19, total: 20, winPct: 95 },
      leadingAfter5: { wins: 18, total: 20, winPct: 90 },
      leadingAfter7: { wins: 17, total: 20, winPct: 85 },
      bigInning: { wins: 12, total: 15, winPct: 80 },
    })
  )?.evidence.length,
  4
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
