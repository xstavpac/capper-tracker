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
//   - real touchdown props stay TD_PROP, and so does every market that has no
//     category of its own yet (combined yards, passing TDs, NHL, MLB)
//   - malformed/unparseable prop text is null, never TD_PROP
//   - the new categories have a tile on the NFL chip set and a label everywhere
//     a category is shown
// Pure (no database).
import {
  pickCategory,
  ALL_CATEGORY_KEYS,
  NFL_CHIP_SET,
  PICK_CATEGORY_LABELS,
  PICK_CATEGORY_MARKET_NOUN,
  STAT_PROP_CATEGORY_KEYS,
  chipSetForLeague,
} from "@/server/data/stats";
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
  check("propMarket=TD -> TD_PROP", propPick({ betDetail: "Josh Allen Anytime TD", propMarket: "TD" }), "TD_PROP");
  // The stored column is the signal, not the text.
  check("propMarket set trusted directly, even over unrelated betDetail text", propPick({ betDetail: "garbled data", propMarket: "TD" }), "TD_PROP");
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

  // --- Real touchdown props stay TD_PROP ---------------------------------
  for (const text of [
    "Puka Nacua Anytime TD",
    "Joe Burrow Anytime TD",
    "Derrick Henry Anytime Touchdown Scorer",
    "Chase Brown rushing TD",
    "Tee Higgins receiving touchdown",
    "Ja'Marr Chase First TD",
    "Kyren Williams 2+ TDs",
  ]) {
    check(`imported "${text}" -> TD_PROP`, imported(text), "TD_PROP");
    check(`legacy (propMarket null) "${text}" -> TD_PROP`, propPick({ betDetail: text }), "TD_PROP");
  }

  // --- Markets with no category of their own yet: unchanged ---------------
  for (const m of ["RUSH_REC_YDS", "PASS_RUSH_YDS", "PASS_TDS"] as const) {
    check(`propMarket=${m} -> TD_PROP (unchanged)`, propPick({ betDetail: null, propMarket: m }), "TD_PROP");
  }
  check("NHL propMarket=SHOTS_ON_GOAL -> TD_PROP (unchanged)", propPick({ betDetail: null, propMarket: "SHOTS_ON_GOAL", sportName: "NHL" }), "TD_PROP");
  check("MLB propMarket=STRIKEOUTS -> TD_PROP (unchanged)", propPick({ betDetail: null, propMarket: "STRIKEOUTS", sportName: "MLB" }), "TD_PROP");

  // --- Fallback path: propMarket null, betDetail re-parsed -----------------
  check("fallback (propMarket null): legacy passing-yards text -> PASS_YDS_PROP", propPick({ betDetail: "Josh Allen Over 275.5 Passing Yards" }), "PASS_YDS_PROP");
  check("fallback (propMarket null): legacy rushing-yards text -> RUSH_YDS_PROP", propPick({ betDetail: "Bijan Robinson Under 65.5 Rushing Yards" }), "RUSH_YDS_PROP");
  check("fallback (propMarket null): legacy receiving-yards text -> REC_YDS_PROP", propPick({ betDetail: "CeeDee Lamb Over 85.5 Receiving Yards" }), "REC_YDS_PROP");
  check("fallback (propMarket null): legacy receptions text -> RECEPTIONS_PROP", propPick({ betDetail: "Justin Jefferson Over 5.5 Receptions" }), "RECEPTIONS_PROP");
  check("fallback (propMarket null): malformed/unparseable prop text -> null, NOT TD_PROP", propPick({ betDetail: "Player Prop" }), null);
  check("fallback (propMarket null): empty betDetail -> null", propPick({ betDetail: "" }), null);

  // --- The new categories are shown ---------------------------------------
  check("the four stat-prop categories", STAT_PROP_CATEGORY_KEYS, ["PASS_YDS_PROP", "RUSH_YDS_PROP", "REC_YDS_PROP", "RECEPTIONS_PROP"]);
  check("TD_PROP is still in ALL_CATEGORY_KEYS", ALL_CATEGORY_KEYS.includes("TD_PROP"), true);
  check("every stat-prop category is in ALL_CATEGORY_KEYS", STAT_PROP_CATEGORY_KEYS.every((k) => ALL_CATEGORY_KEYS.includes(k)), true);
  check("NFL chip set has TD_PROP and every stat-prop tile", (["TD_PROP", ...STAT_PROP_CATEGORY_KEYS] as const).every((k) => NFL_CHIP_SET.includes(k)), true);
  check(
    "no other sport's chip set gained a prop tile",
    ["NCAAF", "NBA", "WNBA", "NCAAB", "NHL", "MLB", "KBO", "CFL"].filter((s) => chipSetForLeague(s).some((k) => k.endsWith("_PROP"))),
    []
  );
  check("tile labels", STAT_PROP_CATEGORY_KEYS.map((k) => PICK_CATEGORY_LABELS[k]), ["Passing Yards", "Rushing Yards", "Receiving Yards", "Receptions"]);
  check("record-line nouns", STAT_PROP_CATEGORY_KEYS.map((k) => PICK_CATEGORY_MARKET_NOUN[k]), ["passing yards", "rushing yards", "receiving yards", "receptions"]);

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
