// Proof for pickCategory's PLAYER_PROP branch (stats.ts) - run with:
//   npx tsx src/server/data/player-prop-categorization-acceptance-test.ts
//
// PR 2 of 3 (schema [merged, PR #72] -> parser/categorization [this PR] ->
// grading). Before this change, pickCategory returned "TD_PROP" for ANY
// betType === "PLAYER_PROP" pick unconditionally - it never actually looked
// at propMarket or betDetail at all, so a manually-entered PLAYER_PROP pick
// with garbage/unrelated text would still silently count as a touchdown
// prop. This proves the new behavior:
//   - every structured propMarket value (PASS_YDS/RUSH_YDS/REC_YDS/
//     RECEPTIONS/TD) still resolves to the one pre-existing TD_PROP tile -
//     no new category is introduced by this PR, and TD_PROP is not renamed
//   - propMarket === null (every row predating this PR, and any manually-
//     entered PLAYER_PROP pick, which never runs through parsePlayerProp)
//     falls back to re-parsing betDetail with the same shared parser import
//     time uses, and the three fallback cases behave distinctly:
//       - legacy TD-prop text -> TD_PROP (unchanged from before this PR)
//       - legacy/manual non-TD prop text (predates this PR's parsing
//         support) -> TD_PROP too, via the same fallback parse - it's a real
//         recognized prop, just resolved by text instead of the column
//       - malformed/unparseable prop text -> null, not TD_PROP (the actual
//         behavior fix - previously this always returned TD_PROP too)
import { pickCategory, ALL_CATEGORY_KEYS } from "@/server/data/stats";
import type { Pick } from "@prisma/client";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function propPick(over: { betDetail: string; propMarket?: Pick["propMarket"] }) {
  return pickCategory({
    betType: "PLAYER_PROP",
    period: "FULL_GAME",
    betDetail: over.betDetail,
    odds: -110,
    line: null,
    sportName: "NFL",
    pickedSide: null,
    mlFavoredSide: null,
    propMarket: over.propMarket ?? null,
  });
}

function main() {
  // --- Structured path: propMarket set, trusted directly -----------------
  //
  // All 5 checks below assert the SAME output, "TD_PROP" - this is
  // intentional, not an oversight. Every currently-supported player-prop
  // market (PASS_YDS/RUSH_YDS/REC_YDS/RECEPTIONS/TD) resolves to the one
  // pre-existing TD_PROP category for now; market-specific category
  // distinction is deliberately deferred, not a gap this PR forgot to
  // close. Splitting these into their own categories requires market-
  // specific grading (this app's grading only knows how to resolve TD
  // props today - see resolveTouchdownProp) and matching category/UI
  // support (new PICK_CATEGORY_LABELS/PICK_CATEGORY_MARKET_NOUN/
  // SPECIALIST_LABELS/CATEGORY_ICONS entries, chip-set membership, etc.) to
  // exist FIRST - adding a category tile before its market is gradeable
  // would just sit permanently PENDING, the same anti-pattern TD_PROP
  // itself is already kept out of NCAAF/NBA/WNBA's chip sets to avoid (see
  // NCAAF_CHIP_SET's own comment in stats.ts). This sequencing - grading
  // and UI touchpoint work landing only once a market is newly-gradeable -
  // is documented in docs/odds-expansion-reconciled-plan.md §5.

  check(
    "propMarket=TD -> TD_PROP",
    propPick({ betDetail: "Josh Allen Anytime TD", propMarket: "TD" }),
    "TD_PROP"
  );
  check(
    "propMarket=PASS_YDS -> TD_PROP (same pre-existing tile, no new category)",
    propPick({ betDetail: "Josh Allen Over 275.5 Passing Yards", propMarket: "PASS_YDS" }),
    "TD_PROP"
  );
  check(
    "propMarket=RUSH_YDS -> TD_PROP",
    propPick({ betDetail: "Bijan Robinson Under 65.5 Rushing Yards", propMarket: "RUSH_YDS" }),
    "TD_PROP"
  );
  check(
    "propMarket=REC_YDS -> TD_PROP",
    propPick({ betDetail: "CeeDee Lamb Over 85.5 Receiving Yards", propMarket: "REC_YDS" }),
    "TD_PROP"
  );
  check(
    "propMarket=RECEPTIONS -> TD_PROP",
    propPick({ betDetail: "Justin Jefferson Over 5.5 Receptions", propMarket: "RECEPTIONS" }),
    "TD_PROP"
  );

  // A structured propMarket is trusted even if betDetail looks nothing like
  // a prop - it's the real signal now, not a re-derived guess.
  check(
    "propMarket set trusted directly, even over unrelated betDetail text",
    propPick({ betDetail: "garbled data", propMarket: "TD" }),
    "TD_PROP"
  );

  // --- Fallback path: propMarket null, three distinct cases ---------------

  check(
    "fallback (propMarket null): legacy TD-prop text -> TD_PROP, unchanged from before this PR",
    propPick({ betDetail: "Puka Nacua Anytime TD" }),
    "TD_PROP"
  );
  check(
    "fallback (propMarket null): legacy/manual non-TD prop text -> TD_PROP via the shared parser fallback",
    propPick({ betDetail: "Josh Allen Over 275.5 Passing Yards" }),
    "TD_PROP"
  );
  check(
    "fallback (propMarket null): malformed/unparseable prop text -> null, NOT TD_PROP (the actual fix)",
    propPick({ betDetail: "Player Prop" }),
    null
  );
  check(
    "fallback (propMarket null): empty betDetail -> null",
    propPick({ betDetail: "" }),
    null
  );

  // TD_PROP is still a real, unrenamed member of the category universe.
  check("TD_PROP is still in ALL_CATEGORY_KEYS", ALL_CATEGORY_KEYS.includes("TD_PROP"), true);

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
