// Proof for parsePlayerProp's two combined-category markets (bet-line.ts -
// RUSH_REC_YDS/PASS_RUSH_YDS) and parseCatalog's end-to-end classification of
// them, run with:
//   npx tsx src/lib/nfl-combined-prop-parsing-acceptance-test.ts
//
// Companion to player-prop-parsing-acceptance-test.ts (the original 5-market
// PR) - kept separate since this covers a distinct later addition (2026-09,
// see PropMarket's comment in schema.prisma for the live market confirmation
// these markets are built against) with its own precedence and typo-mapping
// concerns the original file's cases don't exercise.
//
// PART A - parsePlayerProp directly: both markets extract the right
// playerName + propMarket across connector variants ("and"/"&"/"+"/"/") and
// word order, PASS_RUSH_YDS also matches "passing and receiving" (the known
// capper typo for "passing and rushing" - there is no real pass+receiving
// market for anyone, so this fold-in is unconditional, not gated on the
// player actually being a QB), and the combined patterns are checked BEFORE
// the single-category ones so "rushing"/"passing" alone never eats a
// combined phrase first.
// PART B - parseCatalog end to end: both markets classify as betType
// PLAYER_PROP, same as every other structured market.
import { parsePlayerProp } from "@/lib/bet-line";
import { parseCatalog } from "@/lib/parse-catalog";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function main() {
  // --- PART A: parsePlayerProp - RUSH_REC_YDS ------------------------------

  check(
    "parsePlayerProp: 'Jahmyr Gibbs Over 99.5 Rushing and Receiving Yards' -> RUSH_REC_YDS",
    parsePlayerProp("Jahmyr Gibbs Over 99.5 Rushing and Receiving Yards"),
    { playerName: "Jahmyr Gibbs", propMarket: "RUSH_REC_YDS" }
  );
  check(
    "parsePlayerProp: '+' connector, no 'yards' qualifier: 'Gibbs o124.5 rush + rec' -> RUSH_REC_YDS",
    parsePlayerProp("Gibbs o124.5 rush + rec"),
    { playerName: "Gibbs", propMarket: "RUSH_REC_YDS" }
  );
  check(
    "parsePlayerProp: '/' connector: 'James Cook Under 100.5 Rush/Rec Yds' -> RUSH_REC_YDS",
    parsePlayerProp("James Cook Under 100.5 Rush/Rec Yds"),
    { playerName: "James Cook", propMarket: "RUSH_REC_YDS" }
  );
  check(
    "parsePlayerProp: reversed word order: 'James Cook Under 100.5 Receiving and Rushing Yards' -> RUSH_REC_YDS",
    parsePlayerProp("James Cook Under 100.5 Receiving and Rushing Yards"),
    { playerName: "James Cook", propMarket: "RUSH_REC_YDS" }
  );

  // --- PART A: parsePlayerProp - PASS_RUSH_YDS -----------------------------

  check(
    "parsePlayerProp: 'Josh Allen Over 290.5 Passing and Rushing Yards' -> PASS_RUSH_YDS",
    parsePlayerProp("Josh Allen Over 290.5 Passing and Rushing Yards"),
    { playerName: "Josh Allen", propMarket: "PASS_RUSH_YDS" }
  );
  check(
    "parsePlayerProp: '&' connector, no 'yards' qualifier: 'Allen o290.5 pass & rush' -> PASS_RUSH_YDS",
    parsePlayerProp("Allen o290.5 pass & rush"),
    { playerName: "Allen", propMarket: "PASS_RUSH_YDS" }
  );
  check(
    "parsePlayerProp: reversed word order: 'Allen Over 290.5 Rushing and Passing Yards' -> PASS_RUSH_YDS",
    parsePlayerProp("Allen Over 290.5 Rushing and Passing Yards"),
    { playerName: "Allen", propMarket: "PASS_RUSH_YDS" }
  );

  // --- PART A: the "passing and receiving" typo fold-in --------------------
  // Real bookmakers (confirmed live - see PropMarket's comment) have no
  // pass+receiving market for any player, so this phrase is always the
  // known typo for pass+rushing, folded straight into PASS_RUSH_YDS with no
  // separate market/code path and no player-position check needed.

  check(
    "typo fold-in: 'Josh Allen Over 249.5 Passing and Receiving Yards' -> PASS_RUSH_YDS (not a separate market)",
    parsePlayerProp("Josh Allen Over 249.5 Passing and Receiving Yards"),
    { playerName: "Josh Allen", propMarket: "PASS_RUSH_YDS" }
  );
  check(
    "typo fold-in, reversed order: 'Allen Over 249.5 Receiving and Passing Yards' -> PASS_RUSH_YDS",
    parsePlayerProp("Allen Over 249.5 Receiving and Passing Yards"),
    { playerName: "Allen", propMarket: "PASS_RUSH_YDS" }
  );

  // --- PART A: precedence - combined patterns beat single-category ones ---
  // If checked in the wrong order, "passing" alone (or "rushing" alone)
  // would claim the phrase first, stripping only that one word and leaving
  // "and rushing yards" (or "and receiving yards") stuck in the extracted
  // player name instead of resolving as the combined market.

  check(
    "precedence: combined phrase never misparses as the bare single-category market",
    parsePlayerProp("Josh Allen Over 290.5 Passing and Rushing Yards")?.propMarket,
    "PASS_RUSH_YDS"
  );
  check(
    "precedence: player name is fully isolated, not left with 'and Rushing Yards' stuck on",
    parsePlayerProp("Josh Allen Over 290.5 Passing and Rushing Yards")?.playerName,
    "Josh Allen"
  );

  // --- PART A: single-category markets are unaffected (no regression) -----

  check(
    "regression: plain 'Passing Yards' (no connector) still resolves PASS_YDS, not PASS_RUSH_YDS",
    parsePlayerProp("Josh Allen Over 275.5 Passing Yards"),
    { playerName: "Josh Allen", propMarket: "PASS_YDS" }
  );
  check(
    "regression: plain 'Rushing Yards' (no connector) still resolves RUSH_YDS, not RUSH_REC_YDS",
    parsePlayerProp("Jahmyr Gibbs Over 65.5 Rushing Yards"),
    { playerName: "Jahmyr Gibbs", propMarket: "RUSH_YDS" }
  );

  // --- PART B: parseCatalog end to end -------------------------------------

  const rushRec = parseCatalog(`Capper\nBills Jahmyr Gibbs Over 99.5 Rushing and Receiving Yards`, []).picks[0];
  check("parseCatalog: Rush+Rec Yards pick -> betType PLAYER_PROP", rushRec?.betType, "PLAYER_PROP");
  check("parseCatalog: Rush+Rec Yards pick -> sport still resolves NFL", rushRec?.sportName, "NFL");

  const passRush = parseCatalog(`Capper\nBills Josh Allen Over 290.5 Passing and Rushing Yards`, []).picks[0];
  check("parseCatalog: Pass+Rush Yards pick -> betType PLAYER_PROP", passRush?.betType, "PLAYER_PROP");

  const passRushTypo = parseCatalog(`Capper\nBills Josh Allen Over 249.5 Passing and Receiving Yards`, []).picks[0];
  check("parseCatalog: 'Passing and Receiving' typo pick -> betType PLAYER_PROP", passRushTypo?.betType, "PLAYER_PROP");

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
