// Proof for the production Relationship Classifier (docs/parlay-white-paper.md,
// Section 4). Pure: no DB, no imports beyond the module under test and its
// own dependencies (pick-side.ts, bet-line.ts, team-total-target.ts). Run
// with: npx tsx src/lib/parlay/relationship-classifier-acceptance-test.ts
import { describePick, classifyPair, type PickInput, type GameInput, type ParlayCandidate, type PairOutcome } from "@/lib/parlay/relationship-classifier";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// Real MLB team names, matching pick-side.ts's own nickname-lookup tables
// (see its header comment - "Yankees" resolves against "New York Yankees").
const GAME: GameInput = {
  homeTeam: "New York Yankees",
  awayTeam: "Boston Red Sox",
  gameTime: new Date("2026-09-01T23:00:00Z"),
  sportName: "MLB",
};
// Same two teams, different gameTime - a rematch (common in an MLB series).
const REMATCH_GAME: GameInput = { ...GAME, gameTime: new Date("2026-09-02T23:00:00Z") };
// ATP has no team-nickname table at all (see parse-catalog.ts) - homeTeam
// holds the raw player name, awayTeam is a literal "-" placeholder, same
// shape real ATP picks are stored in (see pick-side.ts's own comment).
const ATP_GAME: GameInput = {
  homeTeam: "Novak Djokovic",
  awayTeam: "-",
  gameTime: new Date("2026-09-05T18:00:00Z"),
  sportName: "ATP",
};

function pick(overrides: Partial<PickInput>): PickInput {
  return { betType: "MONEYLINE", period: "FULL_GAME", betDetail: null, line: null, ...overrides };
}

function pair(a: PickInput, gameA: GameInput, b: PickInput, gameB: GameInput): [ParlayCandidate, ParlayCandidate] {
  return [{ pick: a, game: gameA }, { pick: b, game: gameB }];
}

// Runs classifyPair in both argument orders and asserts both match the same
// expected outcome - the symmetry classifyPair is required to have.
function checkSymmetric(
  label: string,
  a: PickInput,
  b: PickInput,
  expected: PairOutcome,
  gameA: GameInput = GAME,
  gameB: GameInput = GAME
) {
  const [candA, candB] = pair(a, gameA, b, gameB);
  check(`${label} (a,b)`, classifyPair(candA, candB), expected);
  check(`${label} (b,a)`, classifyPair(candB, candA), expected);
}

// ============================================================================
// describePick - the three dimensions, plus INACTIVE/UNDERIVABLE reasons.
// ============================================================================

check(
  "describePick: Yankees ML -> SIDE/FULL_GAME/team",
  describePick(pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }), GAME),
  { status: "OK", reason: null, family: "SIDE", period: "FULL_GAME", level: null, direction: "New York Yankees", line: null, teamTarget: null }
);

check(
  "describePick: Yankees -1.5 spread, DB line present",
  describePick(pick({ betType: "SPREAD", betDetail: "Yankees -1.5", line: -1.5 }), GAME),
  { status: "OK", reason: null, family: "SIDE", period: "FULL_GAME", level: null, direction: "New York Yankees", line: -1.5, teamTarget: null }
);

check(
  "describePick: Yankees -1.5 spread, null DB line -> falls back to bet-line.ts extraction",
  describePick(pick({ betType: "SPREAD", betDetail: "Yankees -1.5", line: null }), GAME),
  { status: "OK", reason: null, family: "SIDE", period: "FULL_GAME", level: null, direction: "New York Yankees", line: -1.5, teamTarget: null }
);

check(
  "describePick: full-game Over 8.5 -> TOTAL/GAME/OVER",
  describePick(pick({ betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 }), GAME),
  { status: "OK", reason: null, family: "TOTAL", period: "FULL_GAME", level: "GAME", direction: "OVER", line: 8.5, teamTarget: null }
);

check(
  "describePick: Yankees team total Over 4.5 -> TOTAL/TEAM, teamTarget resolved",
  describePick(pick({ betType: "TEAM_TOTAL", betDetail: "Yankees Over 4.5", line: 4.5 }), GAME),
  { status: "OK", reason: null, family: "TOTAL", period: "FULL_GAME", level: "TEAM", direction: "OVER", line: 4.5, teamTarget: "New York Yankees" }
);

check(
  "describePick: NRFI -> TOTAL/FIRST_INNING/UNDER",
  describePick(pick({ betType: "NRFI", betDetail: "Yankees NRFI" }), GAME),
  { status: "OK", reason: null, family: "TOTAL", period: "FULL_GAME", level: "FIRST_INNING", direction: "UNDER", line: null, teamTarget: null }
);

check(
  "describePick: YRFI -> TOTAL/FIRST_INNING/OVER",
  describePick(pick({ betType: "NRFI", betDetail: "Yankees YRFI" }), GAME),
  { status: "OK", reason: null, family: "TOTAL", period: "FULL_GAME", level: "FIRST_INNING", direction: "OVER", line: null, teamTarget: null }
);

check(
  "describePick: PLAYER_PROP -> INACTIVE, specific reason",
  describePick(pick({ betType: "PLAYER_PROP", betDetail: "Aaron Judge Over 1.5 Total Bases" }), GAME),
  {
    status: "INACTIVE",
    reason: "PLAYER_PROP has no defined family - player props are not yet classified",
    family: null,
    period: "FULL_GAME",
    level: null,
    direction: null,
    line: null,
    teamTarget: null,
  }
);

check(
  "describePick: unrecognized betType -> UNDERIVABLE, specific reason",
  describePick(pick({ betType: "FUTURE" }), GAME),
  { status: "UNDERIVABLE", reason: 'unrecognized betType "FUTURE"', family: null, period: "FULL_GAME", level: null, direction: null, line: null, teamTarget: null }
);

check(
  "describePick: ATP moneyline -> UNDERIVABLE, specific reason (no team concept)",
  describePick(pick({ betType: "MONEYLINE", betDetail: "Djokovic ML" }), ATP_GAME),
  {
    status: "UNDERIVABLE",
    reason: "side/team unresolvable (e.g. ATP or unmatched betDetail text)",
    family: "SIDE",
    period: "FULL_GAME",
    level: null,
    direction: null,
    line: null,
    teamTarget: null,
  }
);

check(
  "describePick: TOTAL with no over/under text -> UNDERIVABLE, specific reason",
  describePick(pick({ betType: "TOTAL", betDetail: "8.5" }), GAME),
  { status: "UNDERIVABLE", reason: 'betDetail has neither "over" nor "under" text', family: "TOTAL", period: "FULL_GAME", level: "GAME", direction: null, line: 8.5, teamTarget: null }
);

check(
  "describePick: NRFI with unmatched text -> UNDERIVABLE, specific reason",
  describePick(pick({ betType: "NRFI", betDetail: "Yankees first inning" }), GAME),
  { status: "UNDERIVABLE", reason: "betDetail doesn't match NRFI/YRFI text patterns", family: "TOTAL", period: "FULL_GAME", level: "FIRST_INNING", direction: null, line: null, teamTarget: null }
);

// A team total's team target is best-effort, not one of Section 4's three
// derivability dimensions - an unmatched alias leaves teamTarget null but
// the pick is still OK (direction still resolves from "Over"/"Under" text
// independently). Matches the harness's own pickTeamName/matchTeamTotalTeam
// behavior (never a derivability gate) - see the acceptance check's
// "USC" alias findings.
check(
  "describePick: team total with unmatched alias -> still OK, teamTarget null",
  describePick(pick({ betType: "TEAM_TOTAL", betDetail: "USC Over 4.5", line: 4.5 }), GAME),
  { status: "OK", reason: null, family: "TOTAL", period: "FULL_GAME", level: "TEAM", direction: "OVER", line: 4.5, teamTarget: null }
);

// Two team totals that both fail to resolve a team target (both null) must
// NOT be treated as the same total just because both are unknown - null
// never equals null for a team target, even when the two picks' text is
// identical. Distinct UNCLASSIFIED reason from "different total target"
// (which requires both sides to have actually resolved to different teams).
checkSymmetric(
  "two unresolved-alias TEAM_TOTALs, same scope, same direction -> UNCLASSIFIED, team target unresolved",
  pick({ betType: "TEAM_TOTAL", betDetail: "USC Over 4.5", line: 4.5 }),
  pick({ betType: "TEAM_TOTAL", betDetail: "USC Over 5.5", line: 5.5 }),
  { outcome: "UNCLASSIFIED", reason: "team target unresolved" }
);

checkSymmetric(
  "two unresolved-alias TEAM_TOTALs, same scope, opposite direction -> UNCLASSIFIED, team target unresolved",
  pick({ betType: "TEAM_TOTAL", betDetail: "USC Over 4.5", line: 4.5 }),
  pick({ betType: "TEAM_TOTAL", betDetail: "USC Under 4.5", line: 4.5 }),
  { outcome: "UNCLASSIFIED", reason: "team target unresolved" }
);

// One side resolved, one side unresolved - still unresolved overall, never
// guessed as a match OR a mismatch.
checkSymmetric(
  "one resolved + one unresolved-alias TEAM_TOTAL, same scope -> UNCLASSIFIED, team target unresolved",
  pick({ betType: "TEAM_TOTAL", betDetail: "Yankees Over 4.5", line: 4.5 }),
  pick({ betType: "TEAM_TOTAL", betDetail: "USC Over 4.5", line: 4.5 }),
  { outcome: "UNCLASSIFIED", reason: "team target unresolved" }
);

// An unresolved-target TEAM_TOTAL must never register as an EXACT_DUPLICATE
// of another unresolved-target TEAM_TOTAL either, even with identical
// betDetail/line/direction - same "null never equals null" rule applies to
// the duplicate check as to the same-total check.
checkSymmetric(
  "two unresolved-alias TEAM_TOTALs, identical text/line -> UNCLASSIFIED, not EXACT_DUPLICATE",
  pick({ betType: "TEAM_TOTAL", betDetail: "USC Over 4.5", line: 4.5 }),
  pick({ betType: "TEAM_TOTAL", betDetail: "USC Over 4.5", line: 4.5 }),
  { outcome: "UNCLASSIFIED", reason: "team target unresolved" }
);

// ============================================================================
// classifyPair - R1-R6, both argument orders.
// ============================================================================

checkSymmetric(
  "R1: Yankees ML vs Yankees -1.5 spread (same scope, same family, same direction, different market)",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "SPREAD", betDetail: "Yankees -1.5", line: -1.5 }),
  { outcome: "RULE", rule: "R1", category: "CORRELATED", mode: "NEITHER" }
);

checkSymmetric(
  "R2: Yankees ML vs Red Sox ML (same scope, side vs side, opposing team)",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "MONEYLINE", betDetail: "Red Sox ML" }),
  { outcome: "RULE", rule: "R2", category: "OPPOSING", mode: "CONTRARIAN" }
);

checkSymmetric(
  "R3: full-game Over 8.5 vs full-game Under 8.5 (same scope, same total, opposite direction)",
  pick({ betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 }),
  pick({ betType: "TOTAL", betDetail: "Under 8.5", line: 8.5 }),
  { outcome: "RULE", rule: "R3", category: "OPPOSING", mode: "CONTRARIAN" }
);

checkSymmetric(
  "R4: Yankees ML vs full-game Over 8.5 (side vs total, any scope)",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 }),
  { outcome: "RULE", rule: "R4", category: "INDEPENDENT", mode: "AUTO_HEDGE" }
);

checkSymmetric(
  "R5: Yankees ML vs Yankees F5 ML (nested scope, same family, same direction)",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "MONEYLINE", period: "FIRST_HALF", betDetail: "Yankees F5 ML" }),
  { outcome: "RULE", rule: "R5", category: "INDEPENDENT", mode: "AUTO_HEDGE" }
);

checkSymmetric(
  "R6: Yankees ML vs Red Sox F5 ML (nested scope, same family, opposite direction)",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "MONEYLINE", period: "FIRST_HALF", betDetail: "Red Sox F5 ML" }),
  { outcome: "RULE", rule: "R6", category: "EXCLUDED", mode: "NEITHER" }
);

// ============================================================================
// The six original Section 4 examples -> R1, R5, R4, R2, R4, INACTIVE.
// ============================================================================

checkSymmetric(
  "original row 1: Team ML vs same-team spread -> R1",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "SPREAD", betDetail: "Yankees -1.5", line: -1.5 }),
  { outcome: "RULE", rule: "R1", category: "CORRELATED", mode: "NEITHER" }
);

checkSymmetric(
  "original row 2: Team ML vs same-team F5 ML -> R5",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "MONEYLINE", period: "FIRST_HALF", betDetail: "Yankees F5 ML" }),
  { outcome: "RULE", rule: "R5", category: "INDEPENDENT", mode: "AUTO_HEDGE" }
);

checkSymmetric(
  "original row 3: Team ML vs same-team Over/Under (team total) -> R4",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "TEAM_TOTAL", betDetail: "Yankees Over 4.5", line: 4.5 }),
  { outcome: "RULE", rule: "R4", category: "INDEPENDENT", mode: "AUTO_HEDGE" }
);

checkSymmetric(
  "original row 4: Team ML vs opposing ML -> R2",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "MONEYLINE", betDetail: "Red Sox ML" }),
  { outcome: "RULE", rule: "R2", category: "OPPOSING", mode: "CONTRARIAN" }
);

checkSymmetric(
  "original row 5: Team ML vs game Over/Under (SAME_GAME) -> R4",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 }),
  { outcome: "RULE", rule: "R4", category: "INDEPENDENT", mode: "AUTO_HEDGE" }
);

checkSymmetric(
  "original row 6: Team ML vs same-team player prop -> INACTIVE",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "PLAYER_PROP", betDetail: "Aaron Judge Over 1.5 Total Bases" }),
  { outcome: "INACTIVE" }
);

// ============================================================================
// NRFI/YRFI - the level that keeps NRFI distinct from a full-game total.
// ============================================================================

checkSymmetric(
  "NRFI vs full-game Over -> R6 (NRFI=Under, nested, opposite direction)",
  pick({ betType: "NRFI", betDetail: "Yankees NRFI" }),
  pick({ betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 }),
  { outcome: "RULE", rule: "R6", category: "EXCLUDED", mode: "NEITHER" }
);

checkSymmetric(
  "NRFI vs full-game Under -> R5 (NRFI=Under, nested, same direction)",
  pick({ betType: "NRFI", betDetail: "Yankees NRFI" }),
  pick({ betType: "TOTAL", betDetail: "Under 8.5", line: 8.5 }),
  { outcome: "RULE", rule: "R5", category: "INDEPENDENT", mode: "AUTO_HEDGE" }
);

checkSymmetric(
  "NRFI vs YRFI -> R3 (same scope, same total, opposite direction)",
  pick({ betType: "NRFI", betDetail: "Yankees NRFI" }),
  pick({ betType: "NRFI", betDetail: "Yankees YRFI" }),
  { outcome: "RULE", rule: "R3", category: "OPPOSING", mode: "CONTRARIAN" }
);

// ============================================================================
// Exact duplicate vs alternate line.
// ============================================================================

checkSymmetric(
  "exact duplicate: Yankees ML vs Yankees ML -> EXACT_DUPLICATE",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "MONEYLINE", betDetail: "Yankees Moneyline" }),
  { outcome: "EXACT_DUPLICATE" }
);

checkSymmetric(
  "exact duplicate: same team total, same line -> EXACT_DUPLICATE",
  pick({ betType: "TEAM_TOTAL", betDetail: "Yankees Over 4.5", line: 4.5 }),
  pick({ betType: "TEAM_TOTAL", betDetail: "Yankees Over 4.5", line: 4.5 }),
  { outcome: "EXACT_DUPLICATE" }
);

checkSymmetric(
  "alternate total line: Over 8.5 vs Over 7.5 -> R1 (not EXACT_DUPLICATE)",
  pick({ betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 }),
  pick({ betType: "TOTAL", betDetail: "Over 7.5", line: 7.5 }),
  { outcome: "RULE", rule: "R1", category: "CORRELATED", mode: "NEITHER" }
);

// ============================================================================
// ML vs same-team spread with a null DB line -> R1, not EXACT_DUPLICATE.
// ============================================================================

checkSymmetric(
  "ML vs same-team spread, null DB line -> R1 (different betType, never a duplicate)",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML", line: null }),
  pick({ betType: "SPREAD", betDetail: "Yankees -1.5", line: null }), // line falls back to bet-line.ts extraction
  { outcome: "RULE", rule: "R1", category: "CORRELATED", mode: "NEITHER" }
);

// ============================================================================
// TEAM_TOTAL vs game TOTAL -> R5 or R6 by direction.
// ============================================================================

checkSymmetric(
  "TEAM_TOTAL vs game TOTAL, same direction -> R5",
  pick({ betType: "TEAM_TOTAL", betDetail: "Yankees Over 4.5", line: 4.5 }),
  pick({ betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 }),
  { outcome: "RULE", rule: "R5", category: "INDEPENDENT", mode: "AUTO_HEDGE" }
);

checkSymmetric(
  "TEAM_TOTAL vs game TOTAL, opposite direction -> R6",
  pick({ betType: "TEAM_TOTAL", betDetail: "Yankees Over 4.5", line: 4.5 }),
  pick({ betType: "TOTAL", betDetail: "Under 8.5", line: 8.5 }),
  { outcome: "RULE", rule: "R6", category: "EXCLUDED", mode: "NEITHER" }
);

// ============================================================================
// Two different teams' TEAM_TOTALs at the same scope -> UNCLASSIFIED.
// ============================================================================

checkSymmetric(
  "different teams' TEAM_TOTALs, same scope -> UNCLASSIFIED, specific reason",
  pick({ betType: "TEAM_TOTAL", betDetail: "Yankees Over 4.5", line: 4.5 }),
  pick({ betType: "TEAM_TOTAL", betDetail: "Red Sox Over 3.5", line: 3.5 }),
  { outcome: "UNCLASSIFIED", reason: "same scope, different total target (e.g. opposing team's team total)" }
);

// ============================================================================
// Rematch at a different gameTime -> NOT_SAME_GAME.
// ============================================================================

checkSymmetric(
  "rematch, different gameTime -> NOT_SAME_GAME",
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  { outcome: "NOT_SAME_GAME" },
  GAME,
  REMATCH_GAME
);

// ============================================================================
// ATP -> UNDERIVABLE; PLAYER_PROP -> INACTIVE (pair-level).
// ============================================================================

checkSymmetric(
  "ATP moneyline vs match total -> UNDERIVABLE, specific reason",
  pick({ betType: "MONEYLINE", betDetail: "Djokovic ML" }),
  pick({ betType: "TOTAL", betDetail: "Over 22.5", line: 22.5 }),
  { outcome: "UNDERIVABLE", reason: "side/team unresolvable (e.g. ATP or unmatched betDetail text)" },
  ATP_GAME,
  ATP_GAME
);

checkSymmetric(
  "PLAYER_PROP vs Yankees ML -> INACTIVE",
  pick({ betType: "PLAYER_PROP", betDetail: "Aaron Judge Over 1.5 Total Bases" }),
  pick({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
  { outcome: "INACTIVE" }
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
