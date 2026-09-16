// Proof for parsePlayerProp (bet-line.ts) and parseCatalog's PLAYER_PROP
// classification - run with:
//   npx tsx src/lib/player-prop-parsing-acceptance-test.ts
//
// PR 2 of 3 (schema [merged, PR #72] -> parser/categorization [this PR] ->
// grading). Generalizes parseTouchdownProp to the four new structured
// markets (PASS_YDS/RUSH_YDS/REC_YDS/RECEPTIONS), keeping TD detection
// itself completely untouched.
//
// PART A - parsePlayerProp directly: each of the 5 markets extracts the
// right playerName + propMarket from realistic pick text, and text with no
// recognizable market returns null (a manually-entered PLAYER_PROP pick with
// no real prop signal in its text - see stats.ts's propMarket-null fallback).
// PART B - parseCatalog end to end: each of the 5 markets classifies as
// betType PLAYER_PROP (not TOTAL, which "Over"/"Under" text would otherwise
// trigger), and the stored description/betDetail text is untouched by this
// change - same raw text in, same raw text out, only betType classification
// differs from before.
import { parsePlayerProp, parseTouchdownProp } from "@/lib/bet-line";
import { parseCatalog } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function main() {
  // --- PART A: parsePlayerProp -------------------------------------------

  check(
    "parsePlayerProp: 'Puka Nacua Anytime TD' -> TD",
    parsePlayerProp("Puka Nacua Anytime TD"),
    { playerName: "Puka Nacua", propMarket: "TD" }
  );
  check(
    "parsePlayerProp: 'Josh Allen Over 275.5 Passing Yards' -> PASS_YDS",
    parsePlayerProp("Josh Allen Over 275.5 Passing Yards"),
    { playerName: "Josh Allen", propMarket: "PASS_YDS" }
  );
  check(
    "parsePlayerProp: 'Bijan Robinson Under 65.5 Rushing Yards' -> RUSH_YDS",
    parsePlayerProp("Bijan Robinson Under 65.5 Rushing Yards"),
    { playerName: "Bijan Robinson", propMarket: "RUSH_YDS" }
  );
  check(
    "parsePlayerProp: 'CeeDee Lamb Over 85.5 Receiving Yards' -> REC_YDS",
    parsePlayerProp("CeeDee Lamb Over 85.5 Receiving Yards"),
    { playerName: "CeeDee Lamb", propMarket: "REC_YDS" }
  );
  check(
    "parsePlayerProp: 'Justin Jefferson Over 5.5 Receptions' -> RECEPTIONS",
    parsePlayerProp("Justin Jefferson Over 5.5 Receptions"),
    { playerName: "Justin Jefferson", propMarket: "RECEPTIONS" }
  );
  // REC_YDS ("Receiving Yards") vs RECEPTIONS ("Receptions") don't collide -
  // "rec(?:eiving)?" requires a following y(?:ar)?ds?, so bare "Receptions"
  // never matches REC_YDS, and "receptions?" never matches inside "Receiving".
  check(
    "parsePlayerProp: shorthand 'Rec Yds' still resolves REC_YDS, not RECEPTIONS",
    parsePlayerProp("Mike Evans Over 75.5 Rec Yds"),
    { playerName: "Mike Evans", propMarket: "REC_YDS" }
  );

  // Malformed / unparseable prop text - no market keyword at all. This is
  // the case a manually-entered PLAYER_PROP pick (createPickAction, whose
  // betType comes from a dropdown, not text parsing) can produce; stats.ts's
  // propMarket-null fallback relies on this returning null, not a guess.
  check("parsePlayerProp: 'Cubs ML' (not a prop at all) -> null", parsePlayerProp("Cubs ML"), null);
  check("parsePlayerProp: empty string -> null", parsePlayerProp(""), null);
  check("parsePlayerProp: 'Player Prop' (no market keyword) -> null", parsePlayerProp("Player Prop"), null);

  // --- PART B: parseCatalog end to end ------------------------------------

  const passYds = parseCatalog(`Capper\nBills Josh Allen Over 275.5 Passing Yards`, []).picks[0];
  check("parseCatalog: Passing Yards pick -> betType PLAYER_PROP", passYds?.betType, "PLAYER_PROP");
  check("parseCatalog: Passing Yards pick -> sport still resolves NFL", passYds?.sportName, "NFL");
  check(
    "parseCatalog: Passing Yards pick -> description text untouched by betType classification (line/direction stay embedded in the raw text)",
    passYds?.description,
    "Bills Josh Allen Over 275.5 Passing Yards"
  );

  const rushYds = parseCatalog(`Capper\nBills Bijan Robinson Under 65.5 Rushing Yards`, []).picks[0];
  check("parseCatalog: Rushing Yards pick -> betType PLAYER_PROP", rushYds?.betType, "PLAYER_PROP");

  const recYds = parseCatalog(`Capper\nBills CeeDee Lamb Over 85.5 Receiving Yards`, []).picks[0];
  check("parseCatalog: Receiving Yards pick -> betType PLAYER_PROP", recYds?.betType, "PLAYER_PROP");

  const receptions = parseCatalog(`Capper\nBills Justin Jefferson Over 5.5 Receptions`, []).picks[0];
  check("parseCatalog: Receptions pick -> betType PLAYER_PROP", receptions?.betType, "PLAYER_PROP");

  // Regression: existing TD-prop classification/text is completely
  // unaffected by generalizing the betType-detection branch from
  // parseTouchdownProp to parsePlayerProp.
  const td = parseCatalog(`Capper\nBills Josh Allen Anytime TD`, []).picks[0];
  check("parseCatalog: TD prop pick -> betType still PLAYER_PROP (unchanged)", td?.betType, "PLAYER_PROP");
  check(
    "parseCatalog: TD prop pick -> description text unchanged (unchanged)",
    td?.description,
    "Bills Josh Allen Anytime TD"
  );

  // A pick with "Over"/a number but no prop-market keyword still falls
  // through to TOTAL, exactly as before - parsePlayerProp only intercepts
  // text it actually recognizes as one of the 5 known markets.
  const plainTotal = parseCatalog(`Capper\nBills Over 45.5`, []).picks[0];
  check("parseCatalog: plain 'Over 45.5' (no prop keyword) -> still TOTAL, not PLAYER_PROP", plainTotal?.betType, "TOTAL");

  // --- PART C: "o"/"u" shorthand is a first-class format, not an edge case
  // - flush ("o56.5"), spaced ("o 56.5"), and spelled-out ("over 56.5") must
  // all extract the identical clean playerName. Before this fix, the
  // over/under strip only matched the literal words, so a standalone "o"/"u"
  // shorthand token was left attached to the extracted name ("Mike Evans o")
  // - masked in some cases only by luck (fuzzy name matching downstream
  // happening to still be within its edit-distance threshold), never a
  // reliable guarantee. ---
  check(
    "parsePlayerProp: flush 'Mike Evans o56.5 rec yards' -> clean playerName, no trailing 'o'",
    parsePlayerProp("Mike Evans o56.5 rec yards"),
    { playerName: "Mike Evans", propMarket: "REC_YDS" }
  );
  check(
    "parsePlayerProp: spaced 'Mike Evans o 56.5 rec yards' -> same clean playerName as flush",
    parsePlayerProp("Mike Evans o 56.5 rec yards"),
    { playerName: "Mike Evans", propMarket: "REC_YDS" }
  );
  check(
    "parsePlayerProp: spelled-out 'Mike Evans over 56.5 rec yards' -> same clean playerName",
    parsePlayerProp("Mike Evans over 56.5 rec yards"),
    { playerName: "Mike Evans", propMarket: "REC_YDS" }
  );
  check(
    "parsePlayerProp: flush 'Mike Evans u56.5 rec yards' -> clean playerName, no trailing 'u'",
    parsePlayerProp("Mike Evans u56.5 rec yards"),
    { playerName: "Mike Evans", propMarket: "REC_YDS" }
  );
  check(
    "parsePlayerProp: spaced 'Mike Evans u 56.5 rec yards' -> same clean playerName as flush",
    parsePlayerProp("Mike Evans u 56.5 rec yards"),
    { playerName: "Mike Evans", propMarket: "REC_YDS" }
  );
  check(
    "parsePlayerProp: spelled-out 'Mike Evans under 56.5 rec yards' -> same clean playerName",
    parsePlayerProp("Mike Evans under 56.5 rec yards"),
    { playerName: "Mike Evans", propMarket: "REC_YDS" }
  );

  // Negative control, using a REAL player name that could plausibly break a
  // careless fix: "Bo Nix" (Denver Broncos QB) contains "o" immediately
  // followed by another letter, not a digit - \b[ou]\s*(?=\d) requires a
  // word boundary directly before the o/u (there is none between "B" and
  // "o" in "Bo" - both are word characters) AND a digit immediately after
  // (optional whitespace only), so this never matches inside "Bo" at all.
  // The name must come through completely untouched.
  check(
    "parsePlayerProp: real name 'Bo Nix' (contains a bare 'o' mid-word) is untouched",
    parsePlayerProp("Bo Nix Over 225.5 Passing Yards"),
    { playerName: "Bo Nix", propMarket: "PASS_YDS" }
  );

  // --- PART D: ATD recognized as anytime-TD; first/multi-TD recognized as
  // PLAYER_PROP (so they never fall through to the wrong MONEYLINE/TOTAL
  // default) but not silently treated as the anytime-TD market they aren't.
  // See parseTouchdownProp (bet-line.ts) and resolveTouchdownProp
  // (grading.ts) for the grading-time half of this fix. ---

  check("parsePlayerProp: 'Gibbs TD' -> TD", parsePlayerProp("Gibbs TD"), { playerName: "Gibbs", propMarket: "TD" });
  check(
    "parsePlayerProp: 'Gibbs touchdown' -> TD",
    parsePlayerProp("Gibbs touchdown"),
    { playerName: "Gibbs", propMarket: "TD" }
  );
  check(
    "parsePlayerProp: 'Gibbs anytime TD' -> TD",
    parsePlayerProp("Gibbs anytime TD"),
    { playerName: "Gibbs", propMarket: "TD" }
  );
  check(
    "parsePlayerProp: 'Gibbs anytime touchdown' -> TD",
    parsePlayerProp("Gibbs anytime touchdown"),
    { playerName: "Gibbs", propMarket: "TD" }
  );
  check(
    "parsePlayerProp: 'Gibbs ATD' -> TD, same as the spelled-out forms above (previously fell through to null)",
    parsePlayerProp("Gibbs ATD"),
    { playerName: "Gibbs", propMarket: "TD" }
  );

  check(
    "parseTouchdownProp: 'Gibbs first TD' -> parses as a TD-shaped prop, but flagged unsupported (not plain anytime-TD)",
    parseTouchdownProp("Gibbs first TD"),
    {
      playerName: "Gibbs",
      propType: "ANY",
      unsupported: "this bet is a first-touchdown prop, which this app doesn't grade automatically yet - needs manual grading",
    }
  );
  check(
    "parseTouchdownProp: 'Gibbs first touchdown' -> same first-TD flag",
    parseTouchdownProp("Gibbs first touchdown"),
    {
      playerName: "Gibbs",
      propType: "ANY",
      unsupported: "this bet is a first-touchdown prop, which this app doesn't grade automatically yet - needs manual grading",
    }
  );
  check(
    "parseTouchdownProp: 'Gibbs 1st TD' -> same first-TD flag",
    parseTouchdownProp("Gibbs 1st TD"),
    {
      playerName: "Gibbs",
      propType: "ANY",
      unsupported: "this bet is a first-touchdown prop, which this app doesn't grade automatically yet - needs manual grading",
    }
  );
  check(
    "parseTouchdownProp: 'Gibbs 1st touchdown' -> same first-TD flag",
    parseTouchdownProp("Gibbs 1st touchdown"),
    {
      playerName: "Gibbs",
      propType: "ANY",
      unsupported: "this bet is a first-touchdown prop, which this app doesn't grade automatically yet - needs manual grading",
    }
  );
  check(
    "parseTouchdownProp: 'Gibbs 2+ TDs' -> parses as a TD-shaped prop, but flagged unsupported (multi-TD)",
    parseTouchdownProp("Gibbs 2+ TDs"),
    {
      playerName: "Gibbs",
      propType: "ANY",
      unsupported: "this bet is a multi-touchdown (2+/3+) prop, which this app doesn't grade automatically yet - needs manual grading",
    }
  );
  check(
    "parseTouchdownProp: 'Gibbs 2+ touchdowns' -> same multi-TD flag",
    parseTouchdownProp("Gibbs 2+ touchdowns"),
    {
      playerName: "Gibbs",
      propType: "ANY",
      unsupported: "this bet is a multi-touchdown (2+/3+) prop, which this app doesn't grade automatically yet - needs manual grading",
    }
  );
  check(
    "parseTouchdownProp: 'Gibbs 3+ TDs' -> same multi-TD flag",
    parseTouchdownProp("Gibbs 3+ TDs"),
    {
      playerName: "Gibbs",
      propType: "ANY",
      unsupported: "this bet is a multi-touchdown (2+/3+) prop, which this app doesn't grade automatically yet - needs manual grading",
    }
  );

  // First/multi-TD still classify as PLAYER_PROP at import (not the wrong
  // MONEYLINE default a `null` parseTouchdownProp return would produce) -
  // this is what keeps them routed to resolvePlayerProp/resolveTouchdownProp
  // at grading time instead of being graded as a team-moneyline bet.
  const firstTdPick = parseCatalog(`Capper\nBills Gibbs first TD`, []).picks[0];
  check("parseCatalog: first-TD pick -> betType PLAYER_PROP, not MONEYLINE", firstTdPick?.betType, "PLAYER_PROP");
  const multiTdPick = parseCatalog(`Capper\nBills Gibbs 2+ TDs`, []).picks[0];
  check("parseCatalog: multi-TD pick -> betType PLAYER_PROP, not MONEYLINE", multiTdPick?.betType, "PLAYER_PROP");

  // --- PART E (bare stat-category words, real catalog-import gap): the
  // stat-category word alone ("rushing", "passing", "rec") must resolve the
  // same market as when "yards"/"receptions" is spelled out, and "yds"/"yrd"
  // abbreviations of "yards" must be treated equivalently. "rec" alone (no
  // yards qualifier) resolves RECEPTIONS, matching the real-world convention
  // that a bare "REC" column means receptions count, not yards - only
  // promoted to REC_YDS when a yards qualifier is actually attached. ---

  check(
    "parsePlayerProp: bare 'Gibbs over 65.5 rushing' (no 'yards') -> RUSH_YDS",
    parsePlayerProp("Gibbs over 65.5 rushing"),
    { playerName: "Gibbs", propMarket: "RUSH_YDS" }
  );
  check(
    "parsePlayerProp: bare 'Gibbs u 1.5 pass' (no 'yards') -> PASS_YDS",
    parsePlayerProp("Gibbs u 1.5 pass"),
    { playerName: "Gibbs", propMarket: "PASS_YDS" }
  );
  check(
    "parsePlayerProp: bare 'Gibbs over 4.5 rec' (no 'yards'/'receptions') -> RECEPTIONS",
    parsePlayerProp("Gibbs over 4.5 rec"),
    { playerName: "Gibbs", propMarket: "RECEPTIONS" }
  );
  check(
    "parsePlayerProp: bare 'Goff o 245.5 passing' (no 'yards') -> PASS_YDS",
    parsePlayerProp("Goff o 245.5 passing"),
    { playerName: "Goff", propMarket: "PASS_YDS" }
  );
  check(
    "parsePlayerProp: 'rush yds' abbreviation still works (regression)",
    parsePlayerProp("Gibbs over 65.5 rush yds"),
    { playerName: "Gibbs", propMarket: "RUSH_YDS" }
  );
  check(
    "parsePlayerProp: 'rushing yrd' - the 'yrd' abbreviation of yards, previously unrecognized -> RUSH_YDS",
    parsePlayerProp("Gibbs over 65.5 rushing yrd"),
    { playerName: "Gibbs", propMarket: "RUSH_YDS" }
  );
  check(
    "parsePlayerProp: 'rushing yrds' (plural yrd abbreviation) -> RUSH_YDS",
    parsePlayerProp("Gibbs over 65.5 rushing yrds"),
    { playerName: "Gibbs", propMarket: "RUSH_YDS" }
  );
  // Previously-working, yards-qualified forms must still resolve to the
  // exact same market/playerName as before this fix (no regression from
  // making the yards qualifier optional).
  check(
    "parsePlayerProp: 'Gibbs over 65.5 rushing yards' (already worked) -> RUSH_YDS, unchanged",
    parsePlayerProp("Gibbs over 65.5 rushing yards"),
    { playerName: "Gibbs", propMarket: "RUSH_YDS" }
  );
  check(
    "parsePlayerProp: 'Gibbs over 4.5 receptions' (already worked) -> RECEPTIONS, unchanged",
    parsePlayerProp("Gibbs over 4.5 receptions"),
    { playerName: "Gibbs", propMarket: "RECEPTIONS" }
  );
  check(
    "parsePlayerProp: 'Goff over 245.5 passing yards' (already worked) -> PASS_YDS, unchanged",
    parsePlayerProp("Goff over 245.5 passing yards"),
    { playerName: "Goff", propMarket: "PASS_YDS" }
  );

  const bareRushPick = parseCatalog(`Capper\nBills Gibbs over 65.5 rushing`, []).picks[0];
  check("parseCatalog: bare 'rushing' (team-prefixed) pick -> betType PLAYER_PROP", bareRushPick?.betType, "PLAYER_PROP");

  // --- PART F (Part B: bare team-less TD-market lines no longer vanish) -
  // looksLikePick now recognizes touchdown/td/atd directly, so these route
  // to the unresolved bucket (same graceful-decline path as an unresolved
  // player-prop line) instead of being silently misread as a new
  // capper-name header. Verified through the FULL parseCatalog entry point,
  // not parseTouchdownProp/parsePlayerProp called directly - the earlier
  // TD-parsing correctness fix never exercised this path at all. ---

  const bareTdLines = [
    "Gibbs touchdown",
    "Gibbs TD",
    "Gibbs anytime touchdown",
    "Gibbs anytime TD",
    "Gibbs ATD",
    "Gibbs first touchdown",
    "Gibbs first TD",
    "Gibbs 1st TD",
    "Gibbs 2+ TDs",
    "Gibbs 2+ touchdowns",
  ];
  for (const line of bareTdLines) {
    const result = parseCatalog(`godfather\n${line}`, []);
    check(`parseCatalog: bare TD line '${line}' -> 0 picks, lands in unresolved (not silently swallowed)`, {
      picks: result.picks.length,
      unresolved: result.unresolved,
    }, { picks: 0, unresolved: [line] });
    check(`parseCatalog: bare TD line '${line}' -> capper attribution preserved ("godfather"), not overwritten`, result.unresolvedCapperNames, [
      "godfather",
    ]);
  }

  // A multi-line paste mixing a Part A bare-form line and a Part B bare-TD
  // line under the same capper must not corrupt either line or the capper
  // attribution of a real, unrelated pick that follows.
  const mixed = parseCatalog(`godfather\nGibbs over 65.5 rushing\nGibbs touchdown\nLions -3.5`, []);
  check("parseCatalog: mixed paste -> the resolvable 'Lions -3.5' pick still comes through", mixed.picks.length, 1);
  check("parseCatalog: mixed paste -> that pick keeps the correct capper attribution", mixed.picks[0]?.capperName, "godfather");
  check("parseCatalog: mixed paste -> both bare-form lines land in unresolved, in order, neither corrupting the other", mixed.unresolved, [
    "Gibbs over 65.5 rushing",
    "Gibbs touchdown",
  ]);
  check("parseCatalog: mixed paste -> both unresolved lines keep the correct capper attribution", mixed.unresolvedCapperNames, [
    "godfather",
    "godfather",
  ]);

  // End-to-end: once routed to unresolved (not swallowed), the existing
  // roster-fallback recovery pass (added for Part A's "Gibbs over 65.5
  // rushing yards" case) resolves BOTH a Part A bare-form line and a Part B
  // bare TD line into real PLAYER_PROP picks, purely from a bare surname
  // matched against the cached NFL roster - proving the fix isn't just
  // "stops vanishing" but actually completes the import.
  const fixtureRoster: RosterPlayer[] = [
    {
      playerName: "Jahmyr Gibbs",
      firstName: "Jahmyr",
      lastName: "Gibbs",
      team: "Detroit Lions",
      position: "RB",
      espnPlayerId: "1",
    },
  ];
  const { unresolved, unresolvedCapperNames } = parseCatalog(
    `godfather\nGibbs over 65.5 rushing\nGibbs touchdown`,
    []
  );
  const recovery = recoverUnresolvedLines(unresolved, unresolvedCapperNames, [], fixtureRoster);
  check("recoverUnresolvedLines: both bare-form lines fully recover, none left unresolved", recovery.stillUnresolved, []);
  check(
    "recoverUnresolvedLines: bare 'rushing' line recovers as an NFL PLAYER_PROP pick for the right capper",
    { sportName: recovery.recovered[0]?.sportName, betType: recovery.recovered[0]?.betType, capperName: recovery.recovered[0]?.capperName },
    { sportName: "NFL", betType: "PLAYER_PROP", capperName: "godfather" }
  );
  check(
    "recoverUnresolvedLines: bare TD line recovers as an NFL PLAYER_PROP pick for the right capper",
    { sportName: recovery.recovered[1]?.sportName, betType: recovery.recovered[1]?.betType, capperName: recovery.recovered[1]?.capperName },
    { sportName: "NFL", betType: "PLAYER_PROP", capperName: "godfather" }
  );

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
