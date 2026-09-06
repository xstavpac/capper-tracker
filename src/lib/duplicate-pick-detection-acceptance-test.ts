// Proof for the catalog-import duplicate logic - run with:
//   npx tsx src/lib/duplicate-pick-detection-acceptance-test.ts
//
// Covers the 2026-09 within-batch detection fix (the "Clemson +6.5" /
// "Clemson +7" report - two picks that are the same side-aware category but
// never touch the DB, so a DB-only check let a paste duplicate itself), the
// game-segment fix (a Q1 total and a full-game total on one matchup both
// classify as OVER, so period must be part of the dup key - the "Louisville
// Over 54.5" vs "Louisville over 12.5 first quarter" report), the
// end-of-import summary's skip predicate, and the button copy.
import {
  computeDuplicateFlags,
  isSkippedAsDuplicate,
  importButtonLabel,
  type ResolvedDupCandidate,
} from "./duplicate-pick-detection";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const DRIFT = 6 * 3600000; // MAX_GAME_TIME_DRIFT_MS
const T0 = new Date("2026-09-12T23:30:00Z").getTime();

// Minimal candidate builder - defaults describe one Clemson-@-LSU spread by
// "Cody", overridable per test.
function cand(over: Partial<ResolvedDupCandidate> & { index: number }): ResolvedDupCandidate {
  return {
    index: over.index,
    capperKey: over.capperKey ?? "capper-cody",
    capperName: over.capperName ?? "Cody",
    homeTeam: over.homeTeam ?? "LSU Tigers",
    awayTeam: over.awayTeam ?? "Clemson Tigers",
    gameTimeMs: over.gameTimeMs ?? T0,
    category: over.category ?? "SPREAD_PLUS",
    period: over.period ?? "FULL_GAME",
    description: over.description ?? "Clemson +7",
    dbDuplicateLabel: over.dbDuplicateLabel ?? null,
  };
}

// ---------------------------------------------------------------------------
console.log("########## within-batch: the Clemson +6.5 / +7 report ##########");
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "Clemson +6.5" }),
      cand({ index: 1, description: "Clemson +7" }),
    ],
    DRIFT
  );
  check("first Clemson spread is NOT flagged (it imports)", flags[0], undefined);
  check("second Clemson spread IS flagged as a paste duplicate", flags[1], {
    message: 'Cody already has "Clemson +6.5" earlier in this paste - same game, same bet.',
  });
}

// A third copy still matches the first even though the second was also flagged.
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "Clemson +6.5" }),
      cand({ index: 1, description: "Clemson +7" }),
      cand({ index: 2, description: "Clemson +6" }),
    ],
    DRIFT
  );
  check("third copy is flagged too", Boolean(flags[2]), true);
  check("still only the first imports", [flags[0], Boolean(flags[1]), Boolean(flags[2])], [undefined, true, true]);
}

// Genuinely different bets on the same game are NOT flagged.
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "Clemson +7", category: "SPREAD_PLUS" }),
      cand({ index: 1, description: "Clemson ML", category: "DOG_ML" }), // different bet
      cand({ index: 2, description: "LSU -7", category: "SPREAD_MINUS" }), // other side
      cand({ index: 3, description: "Over 55.5", category: "OVER" }),
    ],
    DRIFT
  );
  check("spread / ML / other-side / total on one game: nothing flagged", Object.keys(flags), []);
}

// Different capper, or different game, breaks the match.
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "Clemson +7" }),
      cand({ index: 1, description: "Clemson +7", capperKey: "capper-nicky", capperName: "Nicky" }),
      cand({ index: 2, description: "Clemson +7", awayTeam: "Clemson Tigers", homeTeam: "Florida State Seminoles" }),
    ],
    DRIFT
  );
  check("different capper / different game: nothing flagged", Object.keys(flags), []);
}

// ---------------------------------------------------------------------------
console.log("\n########## game segment / period: different scopes are different bets ##########");

// THE BUG (from the report): a Q1-scoped total and a full-game total on the
// same matchup both classify into the plain OVER category (pickCategory only
// forks by period for FIRST_HALF), so before this fix they flagged each other
// as duplicates. betDetail lines (12.5 vs 54.5) are never compared - only the
// team pair + category + period.
//
// The report was the DB-match path ("...already has a Louisville vs Ole Miss
// Over 54.5 pick logged"), where checkDuplicatePicksAction filters existing
// picks by `p.period === period && pickCategory(...) === category`. That
// filter isn't reachable from here (it needs prisma), but it applies the
// EXACT same (category, period) identity these within-paste cases exercise -
// two items with the same category but a different period must not match.
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "Louisville vs Ole Miss Over 54.5", category: "OVER", period: "FULL_GAME",
        homeTeam: "Ole Miss Rebels", awayTeam: "Louisville Cardinals" }),
      cand({ index: 1, description: "Louisville ole miss over 12.5 first quarter", category: "OVER", period: "FIRST_QUARTER",
        homeTeam: "Ole Miss Rebels", awayTeam: "Louisville Cardinals" }),
    ],
    DRIFT
  );
  check("full-game Over 54.5 and Q1 Over 12.5 on one game: NEITHER flagged", Object.keys(flags), []);
}

// Every segment type vs full game, and adjacent segments vs each other -
// all genuinely different bets, none should flag.
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "over 54.5", category: "OVER", period: "FULL_GAME" }),
      cand({ index: 1, description: "1H over 27.5", category: "FIRST_HALF_OVER", period: "FIRST_HALF" }),
      cand({ index: 2, description: "2H over 26.5", category: "OVER", period: "SECOND_HALF" }),
      cand({ index: 3, description: "Q1 over 12.5", category: "OVER", period: "FIRST_QUARTER" }),
      cand({ index: 4, description: "Q2 over 13.5", category: "OVER", period: "SECOND_QUARTER" }),
      cand({ index: 5, description: "Q3 over 13", category: "OVER", period: "THIRD_QUARTER" }),
      cand({ index: 6, description: "Q4 over 14", category: "OVER", period: "FOURTH_QUARTER" }),
    ],
    DRIFT
  );
  check("full / 1H / 2H / Q1 / Q2 / Q3 / Q4 overs on one game: nothing flagged", Object.keys(flags), []);
}

// NHL periods: P1 / P2 / P3 vs each other and vs full game.
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "over 5.5", category: "OVER", period: "FULL_GAME" }),
      cand({ index: 1, description: "1st period over 1.5", category: "OVER", period: "FIRST_PERIOD" }),
      cand({ index: 2, description: "2nd period over 2", category: "OVER", period: "SECOND_PERIOD" }),
      cand({ index: 3, description: "3rd period over 1.5", category: "OVER", period: "THIRD_PERIOD" }),
    ],
    DRIFT
  );
  check("NHL full / P1 / P2 / P3 overs on one game: nothing flagged", Object.keys(flags), []);
}

// The fix must NOT let a genuine same-segment duplicate through: two Q1 overs
// on the same game are still the same bet.
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "Q1 over 12.5", category: "OVER", period: "FIRST_QUARTER" }),
      cand({ index: 1, description: "1st quarter over 13", category: "OVER", period: "FIRST_QUARTER" }),
    ],
    DRIFT
  );
  check("two Q1 overs, same game: the second IS flagged as a paste duplicate", Boolean(flags[1]), true);
  check("first Q1 over still imports", flags[0], undefined);
}

// F5 (period FIRST_HALF, category F5_OVER) vs full-game over: distinct on
// both category and period - still not a duplicate, and two F5 overs still are.
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "over 8.5", category: "OVER", period: "FULL_GAME" }),
      cand({ index: 1, description: "F5 over 4.5", category: "F5_OVER", period: "FIRST_HALF" }),
      cand({ index: 2, description: "first 5 over 5", category: "F5_OVER", period: "FIRST_HALF" }),
    ],
    DRIFT
  );
  check("full-game over and F5 over: not flagged; the 2nd F5 over IS", [flags[0], flags[1], Boolean(flags[2])], [undefined, undefined, true]);
}

// Q1 spread vs full-game spread (same SPREAD_PLUS category, different period).
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "Clemson +7", category: "SPREAD_PLUS", period: "FULL_GAME" }),
      cand({ index: 1, description: "Clemson 1Q +2.5", category: "SPREAD_PLUS", period: "FIRST_QUARTER" }),
    ],
    DRIFT
  );
  check("full-game +7 and Q1 +2.5: not flagged", Object.keys(flags), []);
}

// Two picks tagged to the same matchup but game times too far apart (a
// different week's game) are not treated as one - the window param matters.
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, gameTimeMs: T0 }),
      cand({ index: 1, gameTimeMs: T0 + DRIFT + 1 }),
      cand({ index: 2, gameTimeMs: T0 + DRIFT }), // exactly on the boundary -> still a dup of #0
    ],
    DRIFT
  );
  check("outside the drift window: not a duplicate", flags[1], undefined);
  check("on the drift boundary: still a duplicate", Boolean(flags[2]), true);
}

// A brand-new capper (in-paste id "new:<name>") can still duplicate itself.
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, capperKey: "new:brandnew", capperName: "Brand New", description: "Clemson +7" }),
      cand({ index: 1, capperKey: "new:brandnew", capperName: "Brand New", description: "Clemson +6.5" }),
    ],
    DRIFT
  );
  check("new capper's second identical pick is flagged", Boolean(flags[1]), true);
}

// ---------------------------------------------------------------------------
console.log("\n########## DB duplicate: re-pasting an already-imported catalog ##########");
{
  // Every item comes back with dbDuplicateLabel set (they're all already logged).
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "Clemson +7", dbDuplicateLabel: "Clemson +7" }),
      cand({ index: 1, description: "Over 55.5", category: "OVER", dbDuplicateLabel: "Over 55.5" }),
    ],
    DRIFT
  );
  check("re-paste: FIRST occurrence is flagged too (it's a DB dup, not a paste dup)", flags[0], {
    message: "Cody already has a Clemson +7 pick logged for this game.",
  });
  check("re-paste: every item flagged", [Boolean(flags[0]), Boolean(flags[1])], [true, true]);
}

// A DB match takes precedence over the in-paste wording.
{
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "Clemson +6.5", dbDuplicateLabel: "Clemson +7" }),
      cand({ index: 1, description: "Clemson +7" }), // would be a paste dup of #0, but #0 was a DB dup
    ],
    DRIFT
  );
  check("#0 uses the DB message", flags[0]?.message.includes("already has a Clemson +7 pick logged"), true);
  check("#1 still flagged (paste dup of #0)", flags[1]?.message.includes("earlier in this paste"), true);
}

// ---------------------------------------------------------------------------
console.log("\n########## end-of-import skip predicate (isSkippedAsDuplicate) ##########");
check("no flag, no choice -> not skipped", isSkippedAsDuplicate(false, undefined), false);
check("flagged, never answered -> SKIPPED by default (the un-scrolled prompt case)", isSkippedAsDuplicate(true, undefined), true);
check("flagged, chose Skip -> skipped", isSkippedAsDuplicate(true, "skip"), true);
check("flagged, chose Import anyway -> NOT skipped", isSkippedAsDuplicate(true, "import"), false);
check("stray choice with no flag -> not skipped", isSkippedAsDuplicate(false, "import"), false);

// ---------------------------------------------------------------------------
console.log("\n########## import button copy ##########");
check("no skips", importButtonLabel(150, 0), "Import 150 picks");
check("singular", importButtonLabel(1, 0), "Import 1 pick");
check("one skipped as duplicate", importButtonLabel(149, 1), "Import 149 picks - 1 skipped as duplicate");
check("several skipped", importButtonLabel(140, 10), "Import 140 picks - 10 skipped as duplicates");
check("re-paste: nothing to import, all skipped", importButtonLabel(0, 12), "Import 0 picks - 12 skipped as duplicates");
check("negative/zero skip count is ignored", importButtonLabel(5, 0), "Import 5 picks");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
