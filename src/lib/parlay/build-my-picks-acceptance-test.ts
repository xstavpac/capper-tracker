// Proof for selectConflictFreeLegs (Build My Picks' Section 9 conflict
// validation). Pure: no DB, no imports beyond the module under test and its
// classifier dependency. Run with:
//   npx tsx src/lib/parlay/build-my-picks-acceptance-test.ts
import { selectConflictFreeLegs, type BuildCandidate } from "@/lib/parlay/build-my-picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const GAME_TIME = new Date("2026-09-01T23:00:00Z");
const REMATCH_TIME = new Date("2026-09-02T23:00:00Z");

function mk(overrides: Partial<BuildCandidate>): BuildCandidate {
  return {
    pickId: "p1",
    label: "pick",
    betType: "MONEYLINE",
    period: "FULL_GAME",
    betDetail: null,
    line: null,
    homeTeam: "New York Yankees",
    awayTeam: "Boston Red Sox",
    gameTime: GAME_TIME,
    sportName: "MLB",
    ...overrides,
  };
}

// ============================================================================
// Opposing MLs on the same game -> higher-ranked kept, other skipped with a note.
// ============================================================================
{
  const yankeesML = mk({ pickId: "a", label: "Capper A — Yankees ML", betDetail: "Yankees ML" });
  const redSoxML = mk({ pickId: "b", label: "Capper B — Red Sox ML", betDetail: "Red Sox ML" });
  const result = selectConflictFreeLegs([yankeesML, redSoxML], 5);
  check("opposing MLs: higher-ranked (first) kept", result.legs.map((l) => l.pickId), ["a"]);
  check("opposing MLs: lower-ranked skipped", result.skipped.map((s) => s.pickId), ["b"]);
  check("opposing MLs: skip reason is conflict", result.skipped[0]?.reason, "conflict");
  check(
    "opposing MLs: skip note names both picks",
    result.skipped[0]?.note,
    "Skipped Capper B — Red Sox ML — conflicts with Capper A — Yankees ML in your parlay"
  );
}

// ============================================================================
// Over vs Under on the same total -> skip. Over 8.5 vs Over 7.5 (R1) -> both allowed.
// ============================================================================
{
  const over85 = mk({ pickId: "a", label: "Over 8.5", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 });
  const under85 = mk({ pickId: "b", label: "Under 8.5", betType: "TOTAL", betDetail: "Under 8.5", line: 8.5 });
  const result = selectConflictFreeLegs([over85, under85], 5);
  check("Over vs Under same total: only the first kept", result.legs.map((l) => l.pickId), ["a"]);
  check("Over vs Under same total: second skipped as conflict", result.skipped[0]?.reason, "conflict");
}
{
  const over85 = mk({ pickId: "a", label: "Over 8.5", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 });
  const over75 = mk({ pickId: "b", label: "Over 7.5", betType: "TOTAL", betDetail: "Over 7.5", line: 7.5 });
  const result = selectConflictFreeLegs([over85, over75], 5);
  check("Over 8.5 vs Over 7.5 (R1, correlated but chosen by user): both allowed", result.legs.map((l) => l.pickId), ["a", "b"]);
  check("Over 8.5 vs Over 7.5: nothing skipped", result.skipped, []);
}

// ============================================================================
// Duplicate pick from two cappers -> skip as duplicate.
// ============================================================================
{
  const capperA = mk({ pickId: "a", label: "Capper A — Yankees ML", betDetail: "Yankees ML" });
  const capperB = mk({ pickId: "b", label: "Capper B — Yankees ML", betDetail: "Yankees Moneyline" });
  const result = selectConflictFreeLegs([capperA, capperB], 5);
  check("duplicate pick: only the first kept", result.legs.map((l) => l.pickId), ["a"]);
  check("duplicate pick: second skipped as duplicate", result.skipped[0]?.reason, "duplicate");
  check("duplicate pick: skip note", result.skipped[0]?.note, "Skipped Capper B — Yankees ML — duplicate of Capper A — Yankees ML");
}

// ============================================================================
// Same teams, different gameTime (rematch) -> both allowed (NOT_SAME_GAME never blocks).
// ============================================================================
{
  const game1 = mk({ pickId: "a", label: "Yankees ML (game 1)", betDetail: "Yankees ML", gameTime: GAME_TIME });
  const game2 = mk({ pickId: "b", label: "Red Sox ML (game 2)", betDetail: "Red Sox ML", gameTime: REMATCH_TIME });
  const result = selectConflictFreeLegs([game1, game2], 5);
  check("rematch, different gameTime: both allowed", result.legs.map((l) => l.pickId), ["a", "b"]);
  check("rematch: nothing skipped", result.skipped, []);
}

// ============================================================================
// Shortfall: N=5 with only 4 conflict-free picks -> K=4 reported, not silently built.
// ============================================================================
{
  const yankeesML = mk({ pickId: "a", label: "Yankees ML", betDetail: "Yankees ML" });
  const redSoxML = mk({ pickId: "b", label: "Red Sox ML", betDetail: "Red Sox ML" }); // R2 conflict with a
  const over85 = mk({ pickId: "c", label: "Over 8.5", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 }); // R4 vs a, fine
  const f5ml = mk({ pickId: "d", label: "Yankees F5 ML", period: "FIRST_HALF", betDetail: "Yankees F5 ML" }); // R5 vs a, R4 vs c, fine
  const teamTotal = mk({ pickId: "e", label: "Yankees Team Total Over 4.5", betType: "TEAM_TOTAL", betDetail: "Yankees Over 4.5", line: 4.5 }); // R4 vs a, R5 vs c (nested, same direction), R4 vs d, fine
  const ranked = [yankeesML, redSoxML, over85, f5ml, teamTotal];
  const result = selectConflictFreeLegs(ranked, 5);
  check("shortfall: only 4 of 5 requested legs available", result.legs.length, 4);
  check("shortfall value", result.shortfall, 1);
  check("shortfall: requested is still 5", result.requested, 5);
  check("shortfall: legs are a, c, d, e (b skipped)", result.legs.map((l) => l.pickId), ["a", "c", "d", "e"]);
  check("shortfall: exactly the conflicting pick was skipped", result.skipped.map((s) => s.pickId), ["b"]);
}

// ============================================================================
// Pool is unchanged after the build (same IDs, same order).
// ============================================================================
{
  const ranked = [
    mk({ pickId: "a", label: "Yankees ML", betDetail: "Yankees ML" }),
    mk({ pickId: "b", label: "Red Sox ML", betDetail: "Red Sox ML" }),
    mk({ pickId: "c", label: "Over 8.5", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 }),
  ];
  const before = ranked.map((p) => p.pickId);
  selectConflictFreeLegs(ranked, 3);
  check("input ranked array is not mutated", ranked.map((p) => p.pickId), before);
}

// ============================================================================
// ATP same-match pair -> both included, with the "couldn't verify" note.
// ============================================================================
{
  const atpGame = { homeTeam: "Novak Djokovic", awayTeam: "-", gameTime: GAME_TIME, sportName: "ATP" };
  const atpML = mk({ pickId: "a", label: "Djokovic ML", betDetail: "Djokovic ML", ...atpGame });
  const atpTotal = mk({
    pickId: "b",
    label: "Match Over 22.5",
    betType: "TOTAL",
    betDetail: "Over 22.5",
    line: 22.5,
    ...atpGame,
  });
  const result = selectConflictFreeLegs([atpML, atpTotal], 5);
  check("ATP same-match pair: both included", result.legs.map((l) => l.pickId), ["a", "b"]);
  check("ATP same-match pair: nothing skipped", result.skipped, []);
  check("ATP same-match pair: one unverified note recorded", result.unverified.length, 1);
  check("ATP same-match pair: unverified note names both picks", result.unverified[0]?.note, "Couldn't verify Match Over 22.5 and Djokovic ML don't conflict");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
