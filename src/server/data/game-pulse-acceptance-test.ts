// Correctness proof for buildGamePulsePanelRows' per-row floor/highlight
// logic in game-pulse.ts, run with:
//   npx tsx src/server/data/game-pulse-acceptance-test.ts
// Not a general test suite (see grading-correctness-acceptance-test.ts for
// the same pattern - this repo has no test runner configured).
//
// Every fixture below is hand-constructed synthetic rate data, not pulled
// from a real game - the situation-detection half of this pipeline (which
// questions are even in play for a given set of innings) lives in
// game-pulse-situations.ts and is verified separately by
// game-pulse-situations-acceptance-test.ts. This file only exercises the
// NEW logic on top of that: per-row eligibility, the "show data if at least
// one side clears the floor" rule, and which side gets highlighted.
//
// Exits non-zero if any assertion fails.
import { buildGamePulsePanelRows } from "./game-pulse";
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

// All-zero rates (every question ineligible) as a base to override per test
// case, so each case only has to specify what it cares about.
function ratesWith(overrides: Partial<Record<SituationalQuestionKey, { wins: number; total: number; winPct: number }>>): SituationalRatesByQuestion {
  const base = {} as SituationalRatesByQuestion;
  for (const q of SITUATIONAL_QUESTIONS) base[q.key] = { wins: 0, total: 0, winPct: 0 };
  return { ...base, ...overrides };
}

const NONE = ratesWith({});

// ---- Always exactly 5 rows, in SITUATIONAL_QUESTIONS' fixed order, even
// with zero data anywhere ----
expect(
  "no historical data for either team: still returns all 5 rows, all showData: false",
  buildGamePulsePanelRows(NONE, NONE).map((r) => ({ key: r.key, showData: r.showData })),
  SITUATIONAL_QUESTIONS.map((q) => ({ key: q.key, showData: false }))
);

// ---- Row-level gate: neither team clears the floor -> "Not enough data" ----
expect(
  "one team has a skewed rate but below the 10-game sample floor: still not enough data (floor requires sample AND skew)",
  buildGamePulsePanelRows(ratesWith({ scoredFirst: { wins: 9, total: 9, winPct: 100 } }), NONE).find((r) => r.key === "scoredFirst")?.showData,
  false
);

expect(
  "one team has plenty of sample but a coin-flip (55%) rate: still not enough data (needs to clear the 58/42 skew too)",
  buildGamePulsePanelRows(ratesWith({ scoredFirst: { wins: 55, total: 100, winPct: 55 } }), NONE).find((r) => r.key === "scoredFirst")?.showData,
  false
);

// ---- Row-level gate: at least one team clears the floor -> shows data ----
expect(
  "home clears the floor (15 games, 71%), away has nothing: row shows data, home highlighted",
  buildGamePulsePanelRows(ratesWith({ scoredFirst: { wins: 11, total: 15, winPct: 71 } }), NONE).find((r) => r.key === "scoredFirst"),
  {
    key: "scoredFirst",
    title: "Scored first",
    home: { wins: 11, total: 15, winPct: 71 },
    away: { wins: 0, total: 0, winPct: 0 },
    homeEligible: true,
    awayEligible: false,
    showData: true,
    highlightSide: "home",
  }
);

// ---- Both teams clear the floor: highlight whichever deviates further
// from 50%, not just whichever is numerically higher ----
expect(
  "both teams clear the floor, home is more extreme (80% vs away's 60%): home highlighted",
  buildGamePulsePanelRows(
    ratesWith({ leadingAfter5: { wins: 8, total: 10, winPct: 80 } }),
    ratesWith({ leadingAfter5: { wins: 6, total: 10, winPct: 60 } })
  ).find((r) => r.key === "leadingAfter5")?.highlightSide,
  "home"
);

expect(
  "both teams clear the floor on the LOW side, away is more extreme (10% vs home's 42%): away highlighted",
  buildGamePulsePanelRows(
    ratesWith({ trailingAfter7: { wins: 42, total: 100, winPct: 42 } }),
    ratesWith({ trailingAfter7: { wins: 5, total: 50, winPct: 10 } })
  ).find((r) => r.key === "trailingAfter7")?.highlightSide,
  "away"
);

// ---- Skew floor boundary: exactly 58/42 clears, one point inside doesn't ----
expect(
  "skew floor boundary: exactly 58% clears (>=, not >)",
  buildGamePulsePanelRows(ratesWith({ bigInning: { wins: 58, total: 100, winPct: 58 } }), NONE).find((r) => r.key === "bigInning")?.showData,
  true
);
expect(
  "skew floor boundary: 57% (one point inside the coin-flip band) does not clear",
  buildGamePulsePanelRows(ratesWith({ bigInning: { wins: 57, total: 100, winPct: 57 } }), NONE).find((r) => r.key === "bigInning")?.showData,
  false
);
expect(
  "skew floor boundary: exactly 42% clears on the low side",
  buildGamePulsePanelRows(ratesWith({ trailingAfter7: { wins: 42, total: 100, winPct: 42 } }), NONE).find((r) => r.key === "trailingAfter7")?.showData,
  true
);

// ---- Sample floor boundary: exactly 10 clears, 9 doesn't (even at 100%) ----
expect(
  "sample floor boundary: exactly 10 games clears",
  buildGamePulsePanelRows(ratesWith({ leadingAfter7: { wins: 10, total: 10, winPct: 100 } }), NONE).find((r) => r.key === "leadingAfter7")?.showData,
  true
);
expect(
  "sample floor boundary: 9 games (one below the floor) does not clear even at 100%",
  buildGamePulsePanelRows(ratesWith({ leadingAfter7: { wins: 9, total: 9, winPct: 100 } }), NONE).find((r) => r.key === "leadingAfter7")?.showData,
  false
);

// ---- Row title includes the live BIG_INNING_RUN_THRESHOLD value, not a
// hardcoded "3" ----
expect(
  "bigInning row title reflects the threshold constant",
  buildGamePulsePanelRows(NONE, NONE).find((r) => r.key === "bigInning")?.title,
  "Big inning (3+ runs)"
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
