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
  dedupCategory,
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
console.log("\n########## dedupCategory: TEAM_TOTAL false-positive (2026-09 3-bug report, Bug 1) ##########");
// Reported bug: importing "Auburn team total over 44.5" flagged a duplicate
// against an existing pick, but no such pick was visible under that game's
// expander, and "Import anyway" appeared to produce nothing. Root cause:
// pickCategory (server/data/stats.ts) deliberately collapses EVERY TEAM_TOTAL
// pick into the single bucket "TEAM_TOTAL" (by design, for one stats tile per
// sport) - checkDuplicatePicksAction reused that same bucket as its
// same-bet key, so any two team-total picks on one game matched each other
// regardless of team/side/over-under. dedupCategory widens the key for
// TEAM_TOTAL only; every other bet type is a pass-through.
{
  check("non-TEAM_TOTAL category passes through unchanged", dedupCategory("FAV_ML", "MONEYLINE", "Auburn ML", "HOME"), "FAV_ML");
  check(
    "TEAM_TOTAL: home-side over vs away-side under -> DIFFERENT keys (the false-positive this fixes)",
    dedupCategory("TEAM_TOTAL", "TEAM_TOTAL", "Auburn Over 44.5", "HOME") ===
      dedupCategory("TEAM_TOTAL", "TEAM_TOTAL", "Georgia Under 21.5", "AWAY"),
    false
  );
  check(
    "TEAM_TOTAL: same team/side, same over-under, different line -> SAME key (still a genuine duplicate)",
    dedupCategory("TEAM_TOTAL", "TEAM_TOTAL", "Auburn Over 44.5", "HOME") ===
      dedupCategory("TEAM_TOTAL", "TEAM_TOTAL", "Auburn Over 45.5", "HOME"),
    true
  );
  check(
    "TEAM_TOTAL: same side, opposite over/under -> DIFFERENT keys",
    dedupCategory("TEAM_TOTAL", "TEAM_TOTAL", "Auburn Over 44.5", "HOME") ===
      dedupCategory("TEAM_TOTAL", "TEAM_TOTAL", "Auburn Under 44.5", "HOME"),
    false
  );
}

// End-to-end through computeDuplicateFlags: two team-total picks on the same
// game, opposite teams, pasted together - must NOT flag each other now that
// `category` carries the dedup-widened key (this is what
// checkDuplicatePicksAction passes in as ResolvedDupCandidate.category).
{
  const auburnOver = dedupCategory("TEAM_TOTAL", "TEAM_TOTAL", "Auburn Over 44.5", "HOME");
  const opponentUnder = dedupCategory("TEAM_TOTAL", "TEAM_TOTAL", "Georgia Under 21.5", "AWAY");
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "Auburn Over 44.5", category: auburnOver, homeTeam: "Auburn Tigers", awayTeam: "Georgia Bulldogs" }),
      cand({ index: 1, description: "Georgia Under 21.5", category: opponentUnder, homeTeam: "Auburn Tigers", awayTeam: "Georgia Bulldogs" }),
    ],
    DRIFT
  );
  check("Auburn Over 44.5 + Georgia Under 21.5 on one game: NEITHER flagged", Object.keys(flags), []);
}

// A genuine repeat of the SAME team-total bet is still caught.
{
  const auburnOver1 = dedupCategory("TEAM_TOTAL", "TEAM_TOTAL", "Auburn Over 44.5", "HOME");
  const auburnOver2 = dedupCategory("TEAM_TOTAL", "TEAM_TOTAL", "Auburn Over 45.5", "HOME");
  const flags = computeDuplicateFlags(
    [
      cand({ index: 0, description: "Auburn Over 44.5", category: auburnOver1, homeTeam: "Auburn Tigers", awayTeam: "Georgia Bulldogs" }),
      cand({ index: 1, description: "Auburn Over 45.5", category: auburnOver2, homeTeam: "Auburn Tigers", awayTeam: "Georgia Bulldogs" }),
    ],
    DRIFT
  );
  check("two Auburn Over team-totals (different lines) on one game: the second IS flagged", Boolean(flags[1]), true);
}

// ---------------------------------------------------------------------------
console.log("\n########## dedupCategory: PLAYER_PROP false-positive (2026-09 Skattebo/Mooney/Likely report) ##########");
// Reported bug: three distinct, legitimate player props from three different
// cappers - "Cam Skattebo touchdown" (NFL), "Darnell Mooney over 11.5
// receiving yards" (NFL), "Isaiah Likely over 4.5 receptions" (NFL) - were
// each wrongly flagged as a duplicate and dropped. Root cause: pickCategory
// (server/data/stats.ts) deliberately collapses EVERY player-prop market
// (TD/REC_YDS/RECEPTIONS/PASS_YDS/RUSH_YDS) into one bucket, "TD_PROP",
// regardless of player or market (a documented, correct tradeoff for
// stats/leaderboard tiles - untouched by this fix) - checkDuplicatePicksAction
// reused that same bucket as its same-bet key with no widening for
// PLAYER_PROP (unlike TEAM_TOTAL above), so ANY two player props on one game
// for the same capper collided regardless of who the pick was actually about.
// dedupCategory now folds in propMarket + the player's name (extracted via
// the same parsePlayerProp used at import time - see bulk-picks.ts) for
// PLAYER_PROP, the same way it already widens TEAM_TOTAL.
{
  const skattebo = dedupCategory("TD_PROP", "PLAYER_PROP", "Cam Skattebo Anytime TD", null);
  const mooney = dedupCategory("TD_PROP", "PLAYER_PROP", "Darnell Mooney Over 11.5 Receiving Yards", null);
  const likely = dedupCategory("TD_PROP", "PLAYER_PROP", "Isaiah Likely Over 4.5 Receptions", null);
  const nabers = dedupCategory("TD_PROP", "PLAYER_PROP", "Malik Nabers Over 5.5 Receptions", null);
  check(
    "Skattebo TD / Mooney rec-yds / Likely receptions / Nabers receptions -> four DIFFERENT keys, not one shared TD_PROP bucket",
    new Set([skattebo, mooney, likely, nabers]).size,
    4
  );
}
{
  // Each of the three exact confirmed repros, paired against an UNRELATED
  // pre-existing player-prop pick for the same capper/game (the actual shape
  // of the report: a capper who already had some other player's prop logged
  // for that game) - none should collide with it.
  const flags = computeDuplicateFlags(
    [
      cand({
        index: 0,
        capperKey: "capper-cheese",
        capperName: "CHEESE",
        description: "Cam Skattebo Anytime TD",
        category: dedupCategory("TD_PROP", "PLAYER_PROP", "Cam Skattebo Anytime TD", null),
      }),
      cand({
        index: 1,
        capperKey: "capper-cheese",
        capperName: "CHEESE",
        description: "Malik Nabers Anytime TD", // unrelated player, already logged for this game
        category: dedupCategory("TD_PROP", "PLAYER_PROP", "Malik Nabers Anytime TD", null),
      }),
      cand({
        index: 2,
        capperKey: "capper-shark",
        capperName: "Shark",
        description: "Darnell Mooney Over 11.5 Receiving Yards",
        category: dedupCategory("TD_PROP", "PLAYER_PROP", "Darnell Mooney Over 11.5 Receiving Yards", null),
      }),
      cand({
        index: 3,
        capperKey: "capper-shark",
        capperName: "Shark",
        description: "Christian Watson Over 45.5 Receiving Yards", // unrelated player, same market even
        category: dedupCategory("TD_PROP", "PLAYER_PROP", "Christian Watson Over 45.5 Receiving Yards", null),
      }),
      cand({
        index: 4,
        capperKey: "capper-thisgirlbetz",
        capperName: "This Girl BETZ",
        description: "Isaiah Likely Over 4.5 Receptions",
        category: dedupCategory("TD_PROP", "PLAYER_PROP", "Isaiah Likely Over 4.5 Receptions", null),
      }),
      cand({
        index: 5,
        capperKey: "capper-thisgirlbetz",
        capperName: "This Girl BETZ",
        description: "Cam Skattebo Anytime TD", // unrelated player+market, same game
        category: dedupCategory("TD_PROP", "PLAYER_PROP", "Cam Skattebo Anytime TD", null),
      }),
    ],
    DRIFT
  );
  check(
    "Skattebo TD, Mooney rec-yds, Likely receptions: none collide with an unrelated player prop for the same capper/game",
    Object.keys(flags),
    []
  );
}
{
  // A genuine duplicate must still be caught: same player, same market, same
  // game, same capper, submitted twice - the widened key must not let real
  // dupes through.
  const flags = computeDuplicateFlags(
    [
      cand({
        index: 0,
        description: "Cam Skattebo Anytime TD",
        category: dedupCategory("TD_PROP", "PLAYER_PROP", "Cam Skattebo Anytime TD", null),
      }),
      cand({
        index: 1,
        description: "Cam Skattebo Anytime Touchdown", // same player+market, reworded
        category: dedupCategory("TD_PROP", "PLAYER_PROP", "Cam Skattebo Anytime Touchdown", null),
      }),
    ],
    DRIFT
  );
  check("two Cam Skattebo Anytime TD entries, same game/capper: the second IS flagged as a real duplicate", Boolean(flags[1]), true);
}
{
  // A real Pick row's OWN stored propMarket/playerName columns (passed as
  // dedupCategory's 5th arg) are used directly rather than re-derived - and
  // still produce the SAME key as a fresh re-parse of the identical text
  // would, so the DB-duplicate-check call site (bulk-picks.ts) and the
  // fresh-item call site never disagree about what "the same prop" means.
  const fromStoredColumns = dedupCategory("TD_PROP", "PLAYER_PROP", "Cam Skattebo Anytime TD", null, {
    propMarket: "TD",
    playerName: "Cam Skattebo",
  });
  const fromFreshParse = dedupCategory("TD_PROP", "PLAYER_PROP", "Cam Skattebo Anytime TD", null);
  check("stored propMarket/playerName columns and a fresh re-parse of the same text agree", fromStoredColumns === fromFreshParse, true);
}
{
  // Unparseable player-prop text (a malformed/manual entry with no
  // recognizable market) falls back to the plain category, unchanged from
  // before this fix - no worse than the old behavior, never a crash.
  const key = dedupCategory("TD_PROP", "PLAYER_PROP", "some garbled prop text with no market", null);
  check("unparseable PLAYER_PROP betDetail: falls back to the bare category", key, "TD_PROP");
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
