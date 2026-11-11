// Proof for pickCategory's PLAYER_PROP branch (stats.ts) - run with:
//   npx tsx src/server/data/player-prop-categorization-acceptance-test.ts
//
// pickCategory used to send every recognized player prop to the one TD_PROP key,
// so a production pick like CHILLY's "Joe Burrow Over 250 Passing Yards" (NFL) was
// stored, and counted, as a touchdown prop. This proves:
//   - passing yards / rushing yards / receiving yards / receptions each get their
//     own category, whether the market comes from the stored propMarket column or
//     (propMarket null: legacy and manually-entered picks) from re-parsing betDetail
//     with the same shared parser import time uses
//   - (version 5) anytime TDs are ANYTIME_TD_PROP, TD counts TD_COUNT_PROP, passing
//     TDs PASS_TDS_PROP, and NHL / MLB / NBA props their own family's keys - nothing
//     is stamped TD_PROP any more (lib/prop-category.ts)
//   - malformed/unparseable prop text is null, never a prop category
//   - every prop category has a tile on its sports' chip sets and a label everywhere
//     a category is shown
// Pure (no database).
import {
  pickCategory,
  ALL_CATEGORY_KEYS,
  NFL_CHIP_SET,
  PICK_CATEGORY_LABELS,
  PICK_CATEGORY_MARKET_NOUN,
  chipSetForLeague,
} from "@/server/data/stats";
import { PROP_CATEGORY_KEYS, propTileKeysForFamily } from "@/lib/prop-category";
import { parsePlayerProp } from "@/lib/bet-line";
import type { Pick } from "@prisma/client";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function propPick(over: { betDetail: string | null; propMarket?: Pick["propMarket"]; sportName?: string }) {
  return pickCategory({
    betType: "PLAYER_PROP",
    period: "FULL_GAME",
    betDetail: over.betDetail,
    odds: -110,
    line: null,
    sportName: over.sportName ?? "NFL",
    pickedSide: null,
    mlFavoredSide: null,
    oddsSource: null,
    propMarket: over.propMarket ?? null,
  });
}

// What import does: parse the text for its market, store it, categorize the row.
function imported(betDetail: string) {
  return propPick({ betDetail, propMarket: (parsePlayerProp(betDetail)?.propMarket ?? null) as Pick["propMarket"] });
}

function main() {
  // --- The production pick ----------------------------------------------
  check('"Joe Burrow Over 250 Passing Yards" parses as PASS_YDS', parsePlayerProp("Joe Burrow Over 250 Passing Yards")?.propMarket, "PASS_YDS");
  check('imported "Joe Burrow Over 250 Passing Yards" -> PASS_YDS_PROP, not TD_PROP', imported("Joe Burrow Over 250 Passing Yards"), "PASS_YDS_PROP");

  // --- Structured path: propMarket set, trusted directly -----------------
  check("propMarket=PASS_YDS -> PASS_YDS_PROP", propPick({ betDetail: "Josh Allen Over 275.5 Passing Yards", propMarket: "PASS_YDS" }), "PASS_YDS_PROP");
  check("propMarket=RUSH_YDS -> RUSH_YDS_PROP", propPick({ betDetail: "Bijan Robinson Under 65.5 Rushing Yards", propMarket: "RUSH_YDS" }), "RUSH_YDS_PROP");
  check("propMarket=REC_YDS -> REC_YDS_PROP", propPick({ betDetail: "CeeDee Lamb Over 85.5 Receiving Yards", propMarket: "REC_YDS" }), "REC_YDS_PROP");
  check("propMarket=RECEPTIONS -> RECEPTIONS_PROP", propPick({ betDetail: "Justin Jefferson Over 5.5 Receptions", propMarket: "RECEPTIONS" }), "RECEPTIONS_PROP");
  check("propMarket=TD -> ANYTIME_TD_PROP", propPick({ betDetail: "Josh Allen Anytime TD", propMarket: "TD" }), "ANYTIME_TD_PROP");
  // The stored column is the signal, not the text.
  check("propMarket set trusted directly, even over unrelated betDetail text", propPick({ betDetail: "garbled data", propMarket: "TD" }), "ANYTIME_TD_PROP");
  check("propMarket=PASS_YDS with no betDetail -> PASS_YDS_PROP", propPick({ betDetail: null, propMarket: "PASS_YDS" }), "PASS_YDS_PROP");

  // --- Import path: the text decides the market ---------------------------
  for (const [text, expected] of [
    ["Joe Burrow Under 249.5 passing yds", "PASS_YDS_PROP"],
    ["Lamar Jackson 245.5 passing", "PASS_YDS_PROP"],
    ["Derrick Henry Over 89.5 Rushing Yards", "RUSH_YDS_PROP"],
    ["Saquon Barkley Over 65.5 rush yds", "RUSH_YDS_PROP"],
    ["Ja'Marr Chase Over 85.5 Receiving Yards", "REC_YDS_PROP"],
    ["Amon-Ra St. Brown Under 70.5 receiving yds", "REC_YDS_PROP"],
    ["Justin Jefferson Over 5.5 Receptions", "RECEPTIONS_PROP"],
    ["Travis Kelce Under 4.5 receptions", "RECEPTIONS_PROP"],
  ] as const) {
    check(`imported "${text}" -> ${expected}`, imported(text), expected);
  }

  // --- Touchdown props (version 5: anytime TD and TD counts split) -------
  for (const text of [
    "Puka Nacua Anytime TD",
    "Joe Burrow Anytime TD",
    "Derrick Henry Anytime Touchdown Scorer",
    "Chase Brown rushing TD",
    "Tee Higgins receiving touchdown",
    "Ja'Marr Chase First TD",
  ]) {
    check(`imported "${text}" -> ANYTIME_TD_PROP`, imported(text), "ANYTIME_TD_PROP");
    check(`legacy (propMarket null) "${text}" -> ANYTIME_TD_PROP`, propPick({ betDetail: text }), "ANYTIME_TD_PROP");
  }
  check('imported "Kyren Williams 2+ TDs" -> TD_COUNT_PROP', imported("Kyren Williams 2+ TDs"), "TD_COUNT_PROP");
  check('legacy (propMarket null) "Kyren Williams 2+ TDs" -> TD_COUNT_PROP', propPick({ betDetail: "Kyren Williams 2+ TDs" }), "TD_COUNT_PROP");

  // --- Every other market: its own family's key (version 5) ----------------
  // Version 3: combined-yards lines have their own key.
  check("propMarket=RUSH_REC_YDS -> RUSH_REC_YDS_PROP", propPick({ betDetail: null, propMarket: "RUSH_REC_YDS" }), "RUSH_REC_YDS_PROP");
  check("propMarket=PASS_RUSH_YDS -> PASS_RUSH_YDS_PROP", propPick({ betDetail: null, propMarket: "PASS_RUSH_YDS" }), "PASS_RUSH_YDS_PROP");
  check("propMarket=PASS_TDS -> PASS_TDS_PROP", propPick({ betDetail: null, propMarket: "PASS_TDS" }), "PASS_TDS_PROP");
  check("NHL propMarket=SHOTS_ON_GOAL -> SOG_PROP", propPick({ betDetail: null, propMarket: "SHOTS_ON_GOAL", sportName: "NHL" }), "SOG_PROP");
  check("NHL propMarket=ANYTIME_GOAL -> ANYTIME_GOAL_PROP", propPick({ betDetail: null, propMarket: "ANYTIME_GOAL", sportName: "NHL" }), "ANYTIME_GOAL_PROP");
  check("MLB propMarket=STRIKEOUTS -> K_PROP", propPick({ betDetail: null, propMarket: "STRIKEOUTS", sportName: "MLB" }), "K_PROP");
  // One PropMarket value, two sports: never one key.
  check("NBA propMarket=POINTS -> PTS_PROP", propPick({ betDetail: null, propMarket: "POINTS", sportName: "NBA" }), "PTS_PROP");
  check("NHL propMarket=POINTS -> NHL_POINTS_PROP", propPick({ betDetail: null, propMarket: "POINTS", sportName: "NHL" }), "NHL_POINTS_PROP");
  check("WNBA shares the basketball keys", propPick({ betDetail: null, propMarket: "REBOUNDS", sportName: "WNBA" }), "REB_PROP");
  check("NCAAF shares the football keys", propPick({ betDetail: null, propMarket: "REC_YDS", sportName: "NCAAF" }), "REC_YDS_PROP");
  // A market its family has no key for, or a sport with no family: OTHER_PROP.
  check("NFL with a hockey market -> OTHER_PROP", propPick({ betDetail: null, propMarket: "SAVES", sportName: "NFL" }), "OTHER_PROP");
  check("ATP (no family) -> OTHER_PROP", propPick({ betDetail: null, propMarket: "REC_YDS", sportName: "ATP" }), "OTHER_PROP");
  check("NCAAB (no family) -> OTHER_PROP", propPick({ betDetail: null, propMarket: "POINTS", sportName: "NCAAB" }), "OTHER_PROP");

  // --- Fallback path: propMarket null, betDetail re-parsed -----------------
  check("fallback (propMarket null): legacy passing-yards text -> PASS_YDS_PROP", propPick({ betDetail: "Josh Allen Over 275.5 Passing Yards" }), "PASS_YDS_PROP");
  check("fallback (propMarket null): legacy rushing-yards text -> RUSH_YDS_PROP", propPick({ betDetail: "Bijan Robinson Under 65.5 Rushing Yards" }), "RUSH_YDS_PROP");
  check("fallback (propMarket null): legacy receiving-yards text -> REC_YDS_PROP", propPick({ betDetail: "CeeDee Lamb Over 85.5 Receiving Yards" }), "REC_YDS_PROP");
  check("fallback (propMarket null): legacy receptions text -> RECEPTIONS_PROP", propPick({ betDetail: "Justin Jefferson Over 5.5 Receptions" }), "RECEPTIONS_PROP");
  check("fallback (propMarket null): malformed/unparseable prop text -> null, NOT a prop category", propPick({ betDetail: "Player Prop" }), null);
  check("fallback (propMarket null): empty betDetail -> null", propPick({ betDetail: "" }), null);

  // --- The categories are shown -------------------------------------------
  const FOOTBALL_STAT = ["PASS_YDS_PROP", "RUSH_YDS_PROP", "REC_YDS_PROP", "RECEPTIONS_PROP", "RUSH_REC_YDS_PROP", "PASS_RUSH_YDS_PROP", "PASS_ATTEMPTS_PROP", "PASS_COMPLETIONS_PROP", "PASS_INTERCEPTIONS_PROP", "RUSH_ATTEMPTS_PROP"] as const;
  check("TD_PROP (legacy alias) is still in ALL_CATEGORY_KEYS", ALL_CATEGORY_KEYS.includes("TD_PROP"), true);
  check("every prop category is in ALL_CATEGORY_KEYS", PROP_CATEGORY_KEYS.every((k) => ALL_CATEGORY_KEYS.includes(k)), true);
  check("ALL_CATEGORY_KEYS has no duplicates", new Set(ALL_CATEGORY_KEYS).size, ALL_CATEGORY_KEYS.length);
  check("NFL chip set: the legacy TD_PROP alias and every football prop tile", ["TD_PROP", ...propTileKeysForFamily("FOOTBALL")].every((k) => NFL_CHIP_SET.includes(k as never)), true);
  const propTiles = (sport: string) => chipSetForLeague(sport).filter((k) => k.endsWith("_PROP"));
  check("NFL prop tiles, in order", propTiles("NFL"), [...propTileKeysForFamily("FOOTBALL"), "TD_PROP"]);
  check("NBA prop tiles", propTiles("NBA"), propTileKeysForFamily("BASKETBALL"));
  check("WNBA prop tiles = NBA's", propTiles("WNBA"), propTileKeysForFamily("BASKETBALL"));
  check("NHL prop tiles", propTiles("NHL"), propTileKeysForFamily("HOCKEY"));
  check("MLB prop tiles", propTiles("MLB"), propTileKeysForFamily("BASEBALL"));
  check(
    "no other sport's chip set has a prop tile (NCAAF prop grading is NFL-only)",
    ["NCAAF", "NCAAB", "KBO", "CFL", "ATP"].filter((s) => propTiles(s).length > 0),
    []
  );
  check("only NFL keeps the legacy TD_PROP tile", ["NBA", "WNBA", "NHL", "MLB"].filter((s) => chipSetForLeague(s).includes("TD_PROP")), []);
  check("football tile labels (unchanged)", FOOTBALL_STAT.map((k) => PICK_CATEGORY_LABELS[k]), ["Passing Yards", "Rushing Yards", "Receiving Yards", "Receptions", "Rush + Rec Yards", "Pass + Rush Yards", "Pass Attempts", "Completions", "Interceptions", "Rushing Attempts"]);
  check("football record-line nouns (unchanged)", FOOTBALL_STAT.map((k) => PICK_CATEGORY_MARKET_NOUN[k]), ["passing yards", "rushing yards", "receiving yards", "receptions", "rushing + receiving yards", "passing + rushing yards", "pass attempts", "completions", "interceptions thrown", "rushing attempts"]);
  check(
    "new tile labels",
    (["ANYTIME_TD_PROP", "PTS_PROP", "ANYTIME_GOAL_PROP", "K_PROP", "OTHER_PROP"] as const).map((k) => PICK_CATEGORY_LABELS[k]),
    ["Anytime TD", "Points", "Anytime Goal", "Strikeouts", "Other props"]
  );
  check("TD_PROP keeps its label while the alias lasts", PICK_CATEGORY_LABELS.TD_PROP, "Player Props");

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
