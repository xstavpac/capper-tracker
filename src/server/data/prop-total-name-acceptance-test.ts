// "total" in front of a player-prop market belongs to the market, not the player's name.
//
// Before this fix "Anton Lundell over 0.5 total points" was stored as player "Anton Lundell total", so
// grading looked for that name in the box score, never found it, and the pick sat in manual grading
// (5 NHL picks in prod on 2026-11-18). The same leak existed for NFL yardage / receptions / TD-count lines.
// A game or team total ("Over 6.5 total") and MLB "total bases" must read exactly as before.
//
// Pure: no DB, no network. Grading runs against the saved PIT @ BUF box score fixture.
import fs from "node:fs";
import path from "node:path";
import { parseAnyPlayerProp, parsePlayerPropLine, normalizeNPlusPlayerProp } from "@/lib/bet-line";
import { parseNhlPlayerProp } from "@/lib/nhl-prop";
import { parseMlbPlayerProp } from "@/lib/mlb-prop";
import { parseNbaProp, normalizeNbaNPlus } from "@/lib/nba-prop";
import { parsePickText } from "@/lib/parse-catalog";
import { stripTotalBeforeMarket } from "@/lib/prop-total-modifier";
import { extractNhlBoxScore } from "@/server/data/nhl-boxscore";
import { extractNhlRosterPlayers } from "@/server/data/nhl-roster";
import { gradeNhlPlayerProp, type NhlPropPick } from "@/server/data/nhl-prop-grading";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8"));
const pitBox = extractNhlBoxScore(fx("nhl-boxscore-401879457-pit-buf.json"))!;
const pitRoster: RosterPlayer[] = extractNhlRosterPlayers("Pittsburgh Penguins", fx("nhl-roster-pit.json"));
const PIT_GAME = { homeTeam: "Buffalo Sabres", awayTeam: "Pittsburgh Penguins" };
// The import path stores the parsed name, and grading prefers the stored name: grade it the way prod does.
function importedPick(betDetail: string): NhlPropPick {
  const parsed = parseNhlPlayerProp(betDetail);
  return { playerName: parsed?.playerName ?? null, propMarket: parsed?.propMarket ?? null, betDetail, ...PIT_GAME };
}
const grade = (betDetail: string) => gradeNhlPlayerProp(importedPick(betDetail), "test", { fetchBox: async () => pitBox, getRoster: async () => pitRoster });
const W = { outcome: "WIN" };
const L = { outcome: "LOSS" };
const P = { outcome: "PUSH" };

async function main() {
  console.log("########## PART A: NHL - same market and name with or without \"total\" ##########");
  {
    for (const [withTotal, without, market, name] of [
      ["Anton Lundell over 0.5 total points", "Anton Lundell over 0.5 points", "POINTS", "Anton Lundell"],
      ["Seth Jones over 0.5 total assists", "Seth Jones over 0.5 assists", "ASSISTS", "Seth Jones"],
      ["Auston Matthews over 3.5 total shots on goal", "Auston Matthews over 3.5 shots on goal", "SHOTS_ON_GOAL", "Auston Matthews"],
      ["Auston Matthews over 3.5 total sog", "Auston Matthews over 3.5 sog", "SHOTS_ON_GOAL", "Auston Matthews"],
      ["Auston Matthews over 3.5 total shots", "Auston Matthews over 3.5 shots", "SHOTS_ON_GOAL", "Auston Matthews"],
      ["Igor Shesterkin over 27.5 total saves", "Igor Shesterkin over 27.5 saves", "SAVES", "Igor Shesterkin"],
      ["Anton Lundell 1+ total goals", "Anton Lundell 1+ goals", "ANYTIME_GOAL", "Anton Lundell"],
      ["Auston Matthews 4+ total shots on goal", "Auston Matthews 4+ shots on goal", "SHOTS_ON_GOAL", "Auston Matthews"],
      ["Anton Lundell 1+ total points", "Anton Lundell 1+ points", "POINTS", "Anton Lundell"],
    ] as const) {
      const a = parseNhlPlayerProp(withTotal);
      check(`"${withTotal}" -> ${market}, player "${name}"`, a, { playerName: name, propMarket: market });
      check(`  same as "${without}"`, a, parseNhlPlayerProp(without));
      // The line reads the same too (N+ forms are rewritten through the "total").
      check(`  same line as without "total"`, parsePlayerPropLine(normalizeNPlusPlayerProp(withTotal)), parsePlayerPropLine(normalizeNPlusPlayerProp(without)));
    }
    // "total" that is NOT directly before the market stays where it is.
    check('"Total" elsewhere in the text is untouched', parseNhlPlayerProp("Total Hockey over 0.5 points")?.playerName, "Total Hockey");
    check("helper: only a 'total' right before the market goes", stripTotalBeforeMarket("Total X over 0.5 total points", /\b(?:points?|pts)\b/i), "Total X over 0.5  points");
    check('"2+ total goals" stays a multi-goal line (not anytime goal)', parseNhlPlayerProp("Anton Lundell 2+ total goals"), parseNhlPlayerProp("Anton Lundell 2+ goals"));
    check("the NHL points cap still applies through 'total' (25+ total points is not hockey)", parseNhlPlayerProp("Anton Lundell 25+ total points"), null);
  }

  console.log("\n########## PART B: NHL grading - the imported name is found in the box score ##########");
  {
    // Crosby 1 G 0 A 2 SOG; Koivunen 1 G 3 SOG; Lapierre 0 G 1 A; Malkin 0 G 0 A 2 SOG; Silovs 23 saves.
    for (const [text, want] of [
      ["Sidney Crosby over 0.5 total points", W],
      ["Sidney Crosby under 0.5 total points", L],
      ["Sidney Crosby over 1 total points", P],
      ["Hendrix Lapierre over 0.5 total assists", W],
      ["Evgeni Malkin over 0.5 total assists", L],
      ["Ville Koivunen over 2.5 total shots on goal", W],
      ["Ville Koivunen under 2.5 total sog", L],
      ["Ville Koivunen over 3 total shots on goal", P],
      ["Arturs Silovs over 22.5 total saves", W],
      ["Sidney Crosby 1+ total goals", W],
      ["Evgeni Malkin 1+ total goals", L],
    ] as const) {
      check(`"${text}"`, await grade(text), want);
    }
    check("old stored name 'Sidney Crosby total' still misses (why the 5 prod rows need a name fix)",
      await gradeNhlPlayerProp({ playerName: "Sidney Crosby total", propMarket: "POINTS", betDetail: "Sidney Crosby over 0.5 total points", ...PIT_GAME }, "test", { fetchBox: async () => pitBox, getRoster: async () => pitRoster }),
      { outcome: null, reason: 'couldn\'t find "Sidney Crosby total" in the box score' });
  }

  console.log("\n########## PART C: NFL - same leak, same fix ##########");
  {
    for (const [withTotal, without, market, name] of [
      ["Bijan Robinson over 80.5 total rushing yards", "Bijan Robinson over 80.5 rushing yards", "RUSH_YDS", "Bijan Robinson"],
      ["Ja'Marr Chase over 6.5 total receptions", "Ja'Marr Chase over 6.5 receptions", "RECEPTIONS", "Ja'Marr Chase"],
      ["Ja'Marr Chase over 70.5 total receiving yards", "Ja'Marr Chase over 70.5 receiving yards", "REC_YDS", "Ja'Marr Chase"],
      ["Jalen Hurts over 32.5 total pass attempts", "Jalen Hurts over 32.5 pass attempts", "PASS_ATTEMPTS", "Jalen Hurts"],
      ["Jalen Hurts over 0.5 total touchdowns", "Jalen Hurts over 0.5 touchdowns", "TD_COUNT", "Jalen Hurts"],
      ["Christian McCaffrey 2+ total touchdowns", "Christian McCaffrey 2+ touchdowns", "TD_COUNT", "Christian McCaffrey"],
      ["Bijan Robinson 80+ total rushing yards", "Bijan Robinson 80+ rushing yards", "RUSH_YDS", "Bijan Robinson"],
    ] as const) {
      const a = parseAnyPlayerProp(normalizeNPlusPlayerProp(withTotal));
      check(`"${withTotal}" -> ${market}, player "${name}"`, a, { playerName: name, propMarket: market });
      check(`  same as "${without}"`, a, parseAnyPlayerProp(normalizeNPlusPlayerProp(without)));
      check(`  same line as without "total"`, parsePlayerPropLine(normalizeNPlusPlayerProp(withTotal)), parsePlayerPropLine(normalizeNPlusPlayerProp(without)));
    }
    // The pin that mattered: a "2+ total touchdowns" line must never be read as an ANYTIME TD.
    check('"2+ total touchdowns" is a TD count, never anytime TD', parseAnyPlayerProp("Christian McCaffrey 2+ total touchdowns")?.propMarket, "TD_COUNT");
  }

  console.log("\n########## PART D: NBA - \"total\" (already stripped there) ##########");
  {
    check('"Stephen Curry over 4.5 total threes"', parseNbaProp("Stephen Curry over 4.5 total threes"), { playerName: "Stephen Curry", propMarket: "THREES_MADE" });
    // The prod case (#493 added the "3pt field goals" wording): no "total" and no "pt" left on the name.
    check('"Sandro Mamukelashvili over 1.5 total 3pt field goals"', parseNbaProp("Sandro Mamukelashvili over 1.5 total 3pt field goals"), { playerName: "Sandro Mamukelashvili", propMarket: "THREES_MADE" });
    check('"Jaden McDaniels over 1.5 total turnovers"', parseNbaProp("Jaden McDaniels over 1.5 total turnovers"), { playerName: "Jaden McDaniels", propMarket: "TURNOVERS" });
    check('"Jaden McDaniels 2+ total turnovers" parses like "2+ turnovers"', parseNbaProp("Jaden McDaniels 2+ total turnovers"), parseNbaProp("Jaden McDaniels 2+ turnovers"));
    check('"Nikola Jokic over 11.5 total rebounds"', parseNbaProp("Nikola Jokic over 11.5 total rebounds"), { playerName: "Nikola Jokic", propMarket: "REBOUNDS" });
    check('"Stephen Curry 4+ total threes" -> Over 3.5', normalizeNbaNPlus("Stephen Curry 4+ total threes"), "Stephen Curry Over 3.5 total threes");
    check('"Stephen Curry 4+ total threes" parses like "4+ threes"', parseNbaProp("Stephen Curry 4+ total threes"), parseNbaProp("Stephen Curry 4+ threes"));
  }

  console.log("\n########## PART E: unaffected - MLB total bases, game and team totals ##########");
  {
    check("MLB 'total bases' is still TOTAL_BASES, name intact", parseMlbPlayerProp("Aaron Judge over 1.5 total bases"), { playerName: "Aaron Judge", propMarket: "TOTAL_BASES", line: 1.5 });
    check("MLB 'total bases' via parseAnyPlayerProp", parseAnyPlayerProp("Aaron Judge over 1.5 total bases")?.propMarket, "TOTAL_BASES");
    for (const text of [
      "Over 6.5 total",
      "Under 6.5 total",
      "Panthers over 6.5 total",
      "Panthers vs Oilers over 6.5 total goals",
      "Lakers vs Celtics over 220.5 total points",
      "Yankees vs Red Sox over 8.5 total runs",
      "Chiefs vs Bills over 47.5 total",
    ]) {
      const p = parsePickText(text);
      check(`game total "${text}" is still a TOTAL, not a player prop`, [p.betType, parseAnyPlayerProp(text), parseNhlPlayerProp(text)], ["TOTAL", null, null]);
    }
    for (const text of ["Panthers team total over 3.5", "Panthers over 3.5 team total goals"]) {
      check(`team total "${text}" is still a TEAM_TOTAL`, parsePickText(text).betType, "TEAM_TOTAL");
    }
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
