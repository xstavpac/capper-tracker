// Correctness proof for buildNflGamePulsePanelRows' per-row floor/highlight
// logic in nfl-game-pulse.ts, run with:
//   npx tsx src/server/data/nfl-game-pulse-acceptance-test.ts
// Not a general test suite (see grading-correctness-acceptance-test.ts for
// the same pattern - this repo has no test runner configured).
//
// Deliberately a short test - this logic is a byte-for-byte port of MLB's
// buildGamePulsePanelRows (game-pulse-acceptance-test.ts already exhaustively
// covers the floor-boundary/highlight-tiebreak arithmetic with 12 cases), so
// this only re-confirms the same behavior actually holds for NFL's own
// question set/types, not re-deriving every boundary case from scratch.
//
// Exits non-zero if any assertion fails.
import { buildNflGamePulsePanelRows } from "./nfl-game-pulse";
import { NFL_SITUATIONAL_QUESTIONS, type NflSituationalQuestionKey, type NflSituationalRatesByQuestion } from "./nfl-game-pulse-situations";

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

function ratesWith(
  overrides: Partial<Record<NflSituationalQuestionKey, { wins: number; total: number; winPct: number }>>
): NflSituationalRatesByQuestion {
  const base = {} as NflSituationalRatesByQuestion;
  for (const q of NFL_SITUATIONAL_QUESTIONS) base[q.key] = { wins: 0, total: 0, winPct: 0 };
  return { ...base, ...overrides };
}

const NONE = ratesWith({});

expect(
  "no historical data for either team: all 5 NFL rows returned, in fixed order, all showData: false",
  buildNflGamePulsePanelRows(NONE, NONE).map((r) => r.key),
  NFL_SITUATIONAL_QUESTIONS.map((q) => q.key)
);

expect(
  "no data anywhere: every row showData: false",
  buildNflGamePulsePanelRows(NONE, NONE).every((r) => r.showData === false),
  true
);

expect(
  "home clears the floor on wonTurnoverBattle (12 games, 75%), away has nothing: shows data, home highlighted",
  buildNflGamePulsePanelRows(ratesWith({ wonTurnoverBattle: { wins: 9, total: 12, winPct: 75 } }), NONE).find(
    (r) => r.key === "wonTurnoverBattle"
  ),
  {
    key: "wonTurnoverBattle",
    title: "Won the turnover battle",
    home: { wins: 9, total: 12, winPct: 75 },
    away: { wins: 0, total: 0, winPct: 0 },
    homeEligible: true,
    awayEligible: false,
    showData: true,
    highlightSide: "home",
  }
);

expect(
  "both sides clear the floor on ledByDoubleDigits, away is more extreme (85% vs home's 62%): away highlighted",
  buildNflGamePulsePanelRows(
    ratesWith({ ledByDoubleDigits: { wins: 8, total: 13, winPct: 62 } }),
    ratesWith({ ledByDoubleDigits: { wins: 17, total: 20, winPct: 85 } })
  ).find((r) => r.key === "ledByDoubleDigits")?.highlightSide,
  "away"
);

expect(
  "row title for the double-digit question reads correctly",
  buildNflGamePulsePanelRows(NONE, NONE).find((r) => r.key === "ledByDoubleDigits")?.title,
  "Led by double digits"
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
