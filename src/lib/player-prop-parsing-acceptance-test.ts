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
import { parsePlayerProp } from "@/lib/bet-line";
import { parseCatalog } from "@/lib/parse-catalog";

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

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
