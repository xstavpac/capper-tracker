// Proof for the catalog-import duplicate logic - run with:
//   npx tsx src/lib/duplicate-pick-detection-acceptance-test.ts
//
// Covers the 2026-09 within-batch detection fix (the "Clemson +6.5" /
// "Clemson +7" report - two picks that are the same side-aware category but
// never touch the DB, so a DB-only check let a paste duplicate itself), the
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
