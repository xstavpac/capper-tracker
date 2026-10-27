// NFL pass attempts / rushing attempts / completions / interceptions (PropMarket PASS_ATTEMPTS, RUSH_ATTEMPTS,
// PASS_COMPLETIONS, PASS_INTERCEPTIONS), the "rush + receive yards" spelling, and the "longest" rejection:
// parsing, catalog import + roster recovery, the stored columns, category, filter, display label, dedup key,
// and grading of what was stored against a real box score.
// Pure - fixture rosters and saved ESPN box scores, no network, no database.
// Run with: npx tsx src/lib/nfl-attempts-interceptions-prop-parsing-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import { parsePlayerProp, parsePlayerPropLine, parseAnyPlayerProp, normalizeNPlusPlayerProp, parseTouchdownProp } from "@/lib/bet-line";
import { parseCatalog, parsePickText, detectUnsupportedPropLine } from "@/lib/parse-catalog";
import { UNSUPPORTED_PROP_REASONS } from "@/lib/unsupported-prop-vocab";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { buildPickDisplayLabel } from "@/lib/pick-display-label";
import { betTypeFilterCategory } from "@/lib/bet-type-filter";
import { dedupCategory } from "@/lib/duplicate-pick-detection";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";
import { resolvePlayerProp } from "@/server/data/grading";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import type { PropMarket } from "@prisma/client";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

// ---- the requested lines ----
const LINES: [string, { playerName: string; propMarket: string } | null][] = [
  ["Sam Darnold over 0.5 interceptions", { playerName: "Sam Darnold", propMarket: "PASS_INTERCEPTIONS" }],
  ["Bo Nix over 0.5 interceptions", { playerName: "Bo Nix", propMarket: "PASS_INTERCEPTIONS" }],
  ["JK Dobbins over 13.5 rushing attempts", { playerName: "JK Dobbins", propMarket: "RUSH_ATTEMPTS" }],
  ["Drake Maye Over 5.5 Rushing Attempts", { playerName: "Drake Maye", propMarket: "RUSH_ATTEMPTS" }],
  ["Rodgers Over 34.5 Pass Attempts", { playerName: "Rodgers", propMarket: "PASS_ATTEMPTS" }],
  ["Kyren Williams over 89.5 rush + receive yards", { playerName: "Kyren Williams", propMarket: "RUSH_REC_YDS" }],
  ["CeeDee Lamb over 24.5 longest reception", null],
];
for (const [text, expected] of LINES) check(`parsePlayerProp: "${text}"`, parsePlayerProp(text), expected);
check("line read from 'Rodgers Over 34.5 Pass Attempts'", parsePlayerPropLine("Rodgers Over 34.5 Pass Attempts"), { direction: "OVER", line: 34.5 });

// ---- other spellings of each market ----
const FORMS: [string, string, string][] = [
  ["Josh Allen under 34.5 passing attempts", "Josh Allen", "PASS_ATTEMPTS"],
  ["Josh Allen o33.5 pass att", "Josh Allen", "PASS_ATTEMPTS"],
  ["Josh Allen over 33.5 pass atts", "Josh Allen", "PASS_ATTEMPTS"],
  ["Derrick Henry over 20.5 rush attempts", "Derrick Henry", "RUSH_ATTEMPTS"],
  ["Derrick Henry u19.5 rushing att", "Derrick Henry", "RUSH_ATTEMPTS"],
  ["Patrick Mahomes over 22.5 completions", "Patrick Mahomes", "PASS_COMPLETIONS"],
  ["Patrick Mahomes over 22.5 pass completions", "Patrick Mahomes", "PASS_COMPLETIONS"],
  ["Patrick Mahomes under 23.5 passing completions", "Patrick Mahomes", "PASS_COMPLETIONS"],
  ["Sam Darnold over 0.5 INT", "Sam Darnold", "PASS_INTERCEPTIONS"],
  ["Sam Darnold o0.5 ints", "Sam Darnold", "PASS_INTERCEPTIONS"],
  ["Sam Darnold over 0.5 interceptions thrown", "Sam Darnold", "PASS_INTERCEPTIONS"],
  ["Sam Darnold under 0.5 passing interceptions", "Sam Darnold", "PASS_INTERCEPTIONS"],
  ["Kyren Williams over 89.5 rush and receive yds", "Kyren Williams", "RUSH_REC_YDS"],
  ["Kyren Williams over 89.5 receive + rush yards", "Kyren Williams", "RUSH_REC_YDS"],
];
for (const [text, player, market] of FORMS) check(`form: "${text}"`, parsePlayerProp(text), { playerName: player, propMarket: market });

// "N+" rewrites to the spelled-out over (count markets), and the stored description keeps the line.
for (const [text, line, market] of [
  ["Sam Darnold 1+ interceptions", 0.5, "PASS_INTERCEPTIONS"],
  ["Derrick Henry 20+ rushing attempts", 19.5, "RUSH_ATTEMPTS"],
  ["Patrick Mahomes 25+ passing completions", 24.5, "PASS_COMPLETIONS"],
  ["Josh Allen 35+ pass attempts", 34.5, "PASS_ATTEMPTS"],
] as const) {
  const desc = parsePickText(text).cleanDescription;
  check(`N+ stored normalized: "${text}"`, [parsePlayerProp(desc)?.propMarket, parsePlayerPropLine(desc)], [market, { direction: "OVER", line }]);
}

// ---- unchanged neighbours: nothing that parsed before parses differently ----
check("rushing yards unchanged", parsePlayerProp("Derrick Henry over 79.5 rushing yards"), { playerName: "Derrick Henry", propMarket: "RUSH_YDS" });
check("passing yards unchanged", parsePlayerProp("Josh Allen Over 275.5 Passing Yards"), { playerName: "Josh Allen", propMarket: "PASS_YDS" });
check("rush and rec unchanged", parsePlayerProp("Jahmyr Gibbs over 99.5 rush and rec yards")?.propMarket, "RUSH_REC_YDS");
check("passing TDs unchanged", parsePlayerProp("Watson over 1.5 passing TDs")?.propMarket, "PASS_TDS");
check("receptions unchanged", parsePlayerProp("Zach Ertz over 2.5 receptions")?.propMarket, "RECEPTIONS");
check("anytime TD unchanged", parsePlayerProp("Puka Nacua Anytime TD")?.propMarket, "TD");
check("interceptions never read as a TD prop", parseTouchdownProp("Sam Darnold over 0.5 interceptions"), null);

// ---- still unsupported: routed to unresolved with the NFL reason, never imported as another market ----
for (const text of [
  "CeeDee Lamb over 24.5 longest reception",
  "Saquon Barkley over 19.5 longest rush",
  "Josh Allen over 39.5 longest completion",
  "CeeDee Lamb longest reception over 24.5",
  "Josh Allen over 34.5 attempts", // bare: pass or rush?
  "Derrick Henry over 15.5 carries",
  "Amon-Ra St. Brown over 5.5 targets",
  "Amon-Ra St. Brown over 5.5 receiving targets",
]) {
  // "receiving targets" is the one that still parses (REC_YDS's bare "receiving"); the catalog's
  // NFL-unsupported check runs first, which the two checks below pin.
  if (!/receiving targets/.test(text)) check(`unsupported: "${text}" not a parsed market`, parsePlayerProp(text), null);
  check(`  reason: "${text}"`, detectUnsupportedPropLine(text)?.reason, UNSUPPORTED_PROP_REASONS.NFL);
  const r = parseCatalog("Capper\n" + text, ["Capper"]);
  check(`  catalog: "${text}" -> unresolved, no pick`, [r.picks.length, r.unresolved.length], [0, 1]);
}
check("receiving targets never reads as REC_YDS via the catalog either", parseCatalog("Capper\nNFL Amon-Ra St. Brown over 5.5 receiving targets", ["Capper"]).picks.length, 0);

// ---- catalog import: sport-prefixed lines import straight to PLAYER_PROP ----
for (const text of ["Sam Darnold over 0.5 interceptions", "JK Dobbins over 13.5 rushing attempts", "Rodgers Over 34.5 Pass Attempts", "Patrick Mahomes over 22.5 completions", "Kyren Williams over 89.5 rush + receive yards"]) {
  const r = parseCatalog("Capper\nNFL " + text, ["Capper"]);
  check(`catalog: "NFL ${text}" -> one NFL PLAYER_PROP`, r.picks.map((p) => [p.sportName, p.betType, p.description]), [["NFL", "PLAYER_PROP", text]]);
}

// ---- roster recovery: QB-only for the passing markets ----
let nextId = 1;
function rp(playerName: string, team: string, position: string): RosterPlayer {
  const [firstName, ...rest] = playerName.split(" ");
  return { playerName, firstName, lastName: rest.join(" "), team, position, externalPlayerId: String(nextId++) };
}
const ROSTER: RosterPlayer[] = [
  rp("Sam Darnold", "Seattle Seahawks", "QB"),
  rp("Bo Nix", "Denver Broncos", "QB"),
  rp("J.K. Dobbins", "Denver Broncos", "RB"),
  rp("Drake Maye", "New England Patriots", "QB"),
  rp("Aaron Rodgers", "Pittsburgh Steelers", "QB"),
  rp("Amari Rodgers", "Indianapolis Colts", "WR"), // shares the surname, not a QB
  rp("Kyren Williams", "Los Angeles Rams", "RB"),
  rp("Caleb Williams", "Chicago Bears", "QB"),
  rp("Sauce Gardner", "Indianapolis Colts", "CB"),
];
function recover(line: string) {
  const r = recoverUnresolvedLines([line], ["Capper"], [], ROSTER);
  return r.recovered.length === 1
    ? { team: r.recovered[0].teamNicknames[0], desc: r.recovered[0].description, ambiguous: !!r.recovered[0].ambiguous }
    : { still: r.stillUnresolved, reason: r.reasons[line] ?? null };
}
check("'Rodgers' pass attempts -> Aaron Rodgers (QB), never the WR", recover("Rodgers Over 34.5 Pass Attempts"), {
  team: "pittsburgh steelers",
  desc: "Rodgers Over 34.5 Pass Attempts",
  ambiguous: false,
});
check("Darnold interceptions recovers to SEA", recover("Sam Darnold over 0.5 interceptions"), { team: "seattle seahawks", desc: "Sam Darnold over 0.5 interceptions", ambiguous: false });
check("'JK Dobbins' (roster: J.K.) rushing attempts recovers to DEN", (recover("JK Dobbins over 13.5 rushing attempts") as any).team, "denver broncos");
check("Drake Maye (a QB) rushing attempts recovers through the generic path", (recover("Drake Maye Over 5.5 Rushing Attempts") as any).team, "new england patriots");
check("Kyren Williams rush + receive recovers to LAR", (recover("Kyren Williams over 89.5 rush + receive yards") as any).team, "los angeles rams");
check("a defender's interceptions are refused with a QB-only reason", recover("Sauce Gardner over 0.5 interceptions"), {
  still: ["Sauce Gardner over 0.5 interceptions"],
  reason: "Sauce Gardner (Indianapolis Colts) is a CB, not a quarterback - interceptions thrown is a QB-only market",
});
check("a non-QB on pass attempts names the market", (recover("Kyren Williams over 0.5 pass attempts") as any).reason, "Kyren Williams (Los Angeles Rams) is a RB, not a quarterback - pass attempts is a QB-only market");
check("the PASS_TDS reason is unchanged", (recover("Kyren Williams over 0.5 passing TDs") as any).reason, "Kyren Williams (Los Angeles Rams) is a RB, not a quarterback - passing TDs is a QB-only market");

// ---- category / filter / label / dedup ----
const CATEGORY: [string, string][] = [
  ["PASS_ATTEMPTS", "PASS_ATTEMPTS_PROP"],
  ["RUSH_ATTEMPTS", "RUSH_ATTEMPTS_PROP"],
  ["PASS_COMPLETIONS", "PASS_COMPLETIONS_PROP"],
  ["PASS_INTERCEPTIONS", "PASS_INTERCEPTIONS_PROP"],
];
for (const [market, category] of CATEGORY) {
  check(`category ${market}`, pickCategory({ betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "x", odds: -110, line: null, sportName: "NFL", pickedSide: null, mlFavoredSide: null, propMarket: market as PropMarket }), category);
}
check("category from text alone (legacy null propMarket)", pickCategory({ betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "JK Dobbins over 13.5 rushing attempts", odds: -110, line: null, sportName: "NFL", pickedSide: null, mlFavoredSide: null, propMarket: null }), "RUSH_ATTEMPTS_PROP");
check("PICK_CATEGORY_VERSION stays 3", PICK_CATEGORY_VERSION, 3);
check("filter category (stored)", betTypeFilterCategory({ betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "x", propMarket: "PASS_INTERCEPTIONS" }), "PASS_INTERCEPTIONS");
check("filter category (from text)", betTypeFilterCategory({ betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "Rodgers Over 34.5 Pass Attempts", propMarket: null }), "PASS_ATTEMPTS");

function label(betDetail: string, playerName: string, propMarket: string) {
  return buildPickDisplayLabel({ betType: "PLAYER_PROP", matched: true, homeTeam: "Atlanta Falcons", awayTeam: "Pittsburgh Steelers", pickedSide: null, line: null, playerName, propMarket, sportName: "NFL", betDetail });
}
check("label PASS_ATTEMPTS", label("Rodgers Over 34.5 Pass Attempts", "Rodgers", "PASS_ATTEMPTS"), "Rodgers Over 34.5 Pass Attempts");
check("label PASS_INTERCEPTIONS (lowercase typed name capitalized, QB-only)", label("sam darnold over 0.5 interceptions", "sam darnold", "PASS_INTERCEPTIONS"), "Sam Darnold Over 0.5 Interceptions");
check("label PASS_COMPLETIONS", label("Patrick Mahomes under 22.5 completions", "Patrick Mahomes", "PASS_COMPLETIONS"), "Patrick Mahomes Under 22.5 Completions");
check("label RUSH_ATTEMPTS", label("JK Dobbins over 13.5 rushing attempts", "JK Dobbins", "RUSH_ATTEMPTS"), "JK Dobbins Over 13.5 Rush Attempts");

// Dedup: same player + different market is not a duplicate; same player + same market is.
const key = (text: string) => {
  const cat = pickCategory({ betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: text, odds: -110, line: null, sportName: "NFL", pickedSide: null, mlFavoredSide: null, propMarket: null }) ?? "";
  return dedupCategory(cat, "PLAYER_PROP", text, null, null, "NFL");
};
check("dedup: Rodgers pass attempts vs pass yards -> different", key("Rodgers Over 34.5 Pass Attempts") === key("Rodgers Over 249.5 Passing Yards"), false);
check("dedup: Rodgers pass attempts vs completions -> different", key("Rodgers Over 34.5 Pass Attempts") === key("Rodgers Over 22.5 Completions"), false);
check("dedup: Maye rushing attempts vs rushing yards -> different", key("Drake Maye Over 5.5 Rushing Attempts") === key("Drake Maye Over 25.5 Rushing Yards"), false);
check("dedup: Darnold interceptions vs passing TDs -> different", key("Sam Darnold over 0.5 interceptions") === key("Sam Darnold over 1.5 passing TDs"), false);
check("dedup: same player, same market, other spelling -> same", key("Sam Darnold over 0.5 interceptions") === key("Sam Darnold o0.5 INT"), true);
check("dedup: same market, different player -> different", key("Sam Darnold over 0.5 interceptions") === key("Bo Nix over 0.5 interceptions"), false);
check(
  "dedup key carries market + player",
  key("Rodgers Over 34.5 Pass Attempts"),
  "PASS_ATTEMPTS_PROP:PASS_ATTEMPTS:" + key("Rodgers Over 34.5 Pass Attempts").split(":")[2]
);

// ---- import -> stored columns -> grade, one of each new market, against real box scores ----
// The stored columns are what bulkImportPicksAction writes: parseAnyPlayerProp(description, sport).
const load = (file: string): any => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "server", "data", "__fixtures__", file), "utf8"));
const GAMES = {
  KC_SEA: { id: "401873022", file: "nfl-boxscore-401873022-kc-sea.json", home: "Seattle Seahawks", away: "Kansas City Chiefs" },
  DEN_ARI: { id: "401873019", file: "nfl-boxscore-401873019-den-ari.json", home: "Arizona Cardinals", away: "Denver Broncos" },
  PIT_ATL: { id: "401872658", file: "nfl-boxscore-401872658-pit-atl.json", home: "Atlanta Falcons", away: "Pittsburgh Steelers" },
  LAR_LV: { id: "401873021", file: "nfl-boxscore-401873021-lar-lv.json", home: "Las Vegas Raiders", away: "Los Angeles Rams" },
};
const GRADE_ROSTER: RosterPlayer[] = [
  { externalPlayerId: "8439", playerName: "Aaron Rodgers", firstName: "Aaron", lastName: "Rodgers", team: "Pittsburgh Steelers", position: "QB" },
];
async function importAndGrade(raw: string, game: (typeof GAMES)[keyof typeof GAMES]) {
  const r = parseCatalog("Capper\nNFL " + raw, ["Capper"]);
  const item = r.picks[0];
  const stored = parseAnyPlayerProp(item.description, item.sportName);
  const res = await resolvePlayerProp(
    { betDetail: item.description, propMarket: (stored?.propMarket ?? null) as PropMarket | null, playerName: stored?.playerName ?? null, homeTeam: game.home, awayTeam: game.away },
    game.id,
    "NFL",
    { fetchSummary: async () => load(game.file), getRoster: async () => GRADE_ROSTER }
  );
  return { stored, outcome: res.outcome };
}

async function main() {
  check("e2e PASS_INTERCEPTIONS: Darnold over 0.5 (1 INT)", await importAndGrade("Sam Darnold over 0.5 interceptions", GAMES.KC_SEA), {
    stored: { playerName: "Sam Darnold", propMarket: "PASS_INTERCEPTIONS" },
    outcome: "WIN",
  });
  check("e2e PASS_ATTEMPTS: Rodgers over 34.5 (40 att)", await importAndGrade("Rodgers Over 34.5 Pass Attempts", GAMES.PIT_ATL), {
    stored: { playerName: "Rodgers", propMarket: "PASS_ATTEMPTS" },
    outcome: "WIN",
  });
  check("e2e PASS_COMPLETIONS: Darnold 21+ (20 cmp)", await importAndGrade("Sam Darnold 21+ completions", GAMES.KC_SEA), {
    stored: { playerName: "Sam Darnold", propMarket: "PASS_COMPLETIONS" },
    outcome: "LOSS",
  });
  check("e2e RUSH_ATTEMPTS: JK Dobbins over 13.5 (6 car)", await importAndGrade("JK Dobbins over 13.5 rushing attempts", GAMES.DEN_ARI), {
    stored: { playerName: "JK Dobbins", propMarket: "RUSH_ATTEMPTS" },
    outcome: "LOSS",
  });
  check("e2e RUSH_REC_YDS via 'receive': Kyren Williams over 89.5 (121)", await importAndGrade("Kyren Williams over 89.5 rush + receive yards", GAMES.LAR_LV), {
    stored: { playerName: "Kyren Williams", propMarket: "RUSH_REC_YDS" },
    outcome: "WIN",
  });

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
