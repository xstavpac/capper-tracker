// NHL player-prop text parsing + catalog-import recovery. No network, no DB.
// Run with:  npx tsx src/lib/nhl-prop-parsing-acceptance-test.ts
//
// Covers every market (over, under, N+, anytime yes/no, first goal, points,
// assists, goalie saves), bare-surname and full-name roster resolution, a
// surname collision staying unresolved, the basketball-vocabulary guards for
// points/assists, the tennis-phantom guard, and controls proving NFL parsing is
// byte-for-byte unchanged and MLB props stay unsupported.
import fs from "node:fs";
import path from "node:path";
import { parseNhlPlayerProp, nhlAnytimeGoalSide } from "@/lib/nhl-prop";
import { parsePlayerProp, parseAnyPlayerProp, normalizeNPlusPlayerProp, parsePlayerPropLine } from "@/lib/bet-line";
import { parseCatalog, parsePickText, detectUnsupportedPropLine } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { UNSUPPORTED_PROP_REASONS } from "@/lib/unsupported-prop-vocab";
import { extractNhlRosterPlayers } from "@/server/data/nhl-roster";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const pit = extractNhlRosterPlayers(
  "Pittsburgh Penguins",
  JSON.parse(fs.readFileSync(path.join(__dirname, "../server/data/__fixtures__/nhl-roster-pit.json"), "utf8"))
);
const p = (playerName: string, team: string, position = "C", id = playerName): RosterPlayer => {
  const [first, ...rest] = playerName.split(" ");
  return { playerName, firstName: first, lastName: rest.join(" "), team, position, espnPlayerId: "syn-" + id };
};
// Two "Johnson"s on different teams (collision), one unique synthetic star.
const roster: RosterPlayer[] = [
  ...pit,
  p("Jack Johnson", "Buffalo Sabres", "D"),
  p("Erik Johnson", "Boston Bruins", "D"),
  p("Nick Paul", "Tampa Bay Lightning", "C"),
  p("Dustin Wolf", "Calgary Flames", "G"),
];

function recover(...lines: string[]) {
  return recoverUnresolvedLines(lines, lines.map(() => "Krash"), [], [], [], roster);
}
function recovered1(line: string) {
  const r = recover(line);
  const pick = r.recovered[0];
  return pick ? { sport: pick.sportName, betType: pick.betType, team: pick.teamNicknames[0], desc: pick.description, still: r.stillUnresolved.length } : { still: r.stillUnresolved.length };
}

function main() {
  // ---- parseNhlPlayerProp: every market -----------------------------------
  const cases: [string, string, string][] = [
    ["Sidney Crosby over 3.5 shots on goal", "SHOTS_ON_GOAL", "Sidney Crosby"],
    ["Sidney Crosby under 3.5 shots on goal", "SHOTS_ON_GOAL", "Sidney Crosby"],
    ["Sidney Crosby o3.5 SOG", "SHOTS_ON_GOAL", "Sidney Crosby"],
    ["Sidney Crosby 4+ shots on goal", "SHOTS_ON_GOAL", "Sidney Crosby"],
    ["Sidney Crosby over 0.5 points", "POINTS", "Sidney Crosby"],
    ["Sidney Crosby 1+ points", "POINTS", "Sidney Crosby"],
    ["Evgeni Malkin over 0.5 assists", "ASSISTS", "Evgeni Malkin"],
    ["Evgeni Malkin 2+ assists", "ASSISTS", "Evgeni Malkin"],
    ["Arturs Silovs over 23.5 saves", "SAVES", "Arturs Silovs"],
    ["Arturs Silovs under 23.5 saves", "SAVES", "Arturs Silovs"],
    ["Arturs Silovs 25+ saves", "SAVES", "Arturs Silovs"],
    ["Sidney Crosby anytime goal scorer", "ANYTIME_GOAL", "Sidney Crosby"],
    ["Sidney Crosby to score a goal", "ANYTIME_GOAL", "Sidney Crosby"],
    ["Sidney Crosby goal scorer", "ANYTIME_GOAL", "Sidney Crosby"],
    ["Sidney Crosby 1+ goals", "ANYTIME_GOAL", "Sidney Crosby"],
    ["Sidney Crosby first goal scorer", "FIRST_GOAL", "Sidney Crosby"],
    ["Sidney Crosby 1st goal scorer", "FIRST_GOAL", "Sidney Crosby"],
    ["Crosby anytime goal scorer", "ANYTIME_GOAL", "Crosby"],
  ];
  for (const [text, market, name] of cases) {
    check(`parse: "${text}"`, parseNhlPlayerProp(text), { playerName: name, propMarket: market });
  }
  check("N+ rewrite: shots", normalizeNPlusPlayerProp("Sidney Crosby 4+ shots on goal"), "Sidney Crosby Over 3.5 shots on goal");
  check("N+ rewrite: 1+ goals -> anytime goal", normalizeNPlusPlayerProp("Sidney Crosby 1+ goals"), "Sidney Crosby Anytime Goal");
  check("N+ line reads back as OVER n-0.5", parsePlayerPropLine(normalizeNPlusPlayerProp("Sidney Crosby 4+ shots on goal")), { direction: "OVER", line: 3.5 });
  check("N+ saves line", parsePlayerPropLine(normalizeNPlusPlayerProp("Arturs Silovs 25+ saves")), { direction: "OVER", line: 24.5 });
  check("anytime side: default YES", nhlAnytimeGoalSide("Sidney Crosby anytime goal scorer"), "YES");
  check("anytime side: No Goal Scorer", nhlAnytimeGoalSide("Sidney Crosby no goal scorer"), "NO");
  check("anytime side: Goal Scorer - No", nhlAnytimeGoalSide("Sidney Crosby anytime goal scorer - no"), "NO");
  check("anytime side: not to score", nhlAnytimeGoalSide("Sidney Crosby not to score"), "NO");

  // ---- declined / guarded shapes ------------------------------------------
  check("2+ goals (multi-goal) is not an NHL market", parseNhlPlayerProp("Sidney Crosby 2+ goals"), null);
  check("points line above the hockey cap is not NHL", parseNhlPlayerProp("Johnson over 24.5 points"), null);
  check("assists line above the cap is not NHL", parseNhlPlayerProp("Nikola Jokic over 10.5 assists"), null);
  check("25+ points is not NHL", normalizeNPlusPlayerProp("Caitlin Clark 25+ points"), "Caitlin Clark 25+ points");
  check("points with no line is not a market", parseNhlPlayerProp("Sidney Crosby points"), null);
  check("saves with no line is not a market (a capper named Saves Sam)", parseNhlPlayerProp("Saves Sam"), null);
  check("power-play points is a different market, declined", parseNhlPlayerProp("Sidney Crosby over 0.5 PP points"), null);
  check("1st-period shots is a different market, declined", parseNhlPlayerProp("Sidney Crosby over 1.5 1st period shots on goal"), null);

  // ---- capper shorthand ------------------------------------------------------
  const short: [string, string, string][] = [
    ["McDavid o3.5 SOG", "SHOTS_ON_GOAL", "McDavid"],
    ["McDavid o3.5 sog", "SHOTS_ON_GOAL", "McDavid"],
    ["McDavid u2.5 SOGs", "SHOTS_ON_GOAL", "McDavid"],
    ["Matthews over 4.5 shots", "SHOTS_ON_GOAL", "Matthews"],
    ["Matthews o4.5 shots", "SHOTS_ON_GOAL", "Matthews"],
    ["Matthews u4.5 shots", "SHOTS_ON_GOAL", "Matthews"],
    ["Matthews 4+ shots", "SHOTS_ON_GOAL", "Matthews"],
    ["McDavid ATGS", "ANYTIME_GOAL", "McDavid"],
    ["McDavid ATG", "ANYTIME_GOAL", "McDavid"],
    ["McDavid AGS", "ANYTIME_GOAL", "McDavid"],
    ["McDavid anytime goal", "ANYTIME_GOAL", "McDavid"],
    ["McDavid anytime scorer", "ANYTIME_GOAL", "McDavid"],
    ["McDavid anytime goalscorer", "ANYTIME_GOAL", "McDavid"],
    ["McDavid FGS", "FIRST_GOAL", "McDavid"],
    ["McDavid first goal", "FIRST_GOAL", "McDavid"],
    ["McDavid first goalscorer", "FIRST_GOAL", "McDavid"],
    ["Matthews o1.5 pts", "POINTS", "Matthews"],
    ["Matthews u1.5 pts", "POINTS", "Matthews"],
    ["Matthews 2+ pts", "POINTS", "Matthews"],
    ["Matthews o0.5 ast", "ASSISTS", "Matthews"],
    ["Matthews 2+ ast", "ASSISTS", "Matthews"],
  ];
  for (const [text, market, name] of short) {
    check(`shorthand: "${text}"`, parseNhlPlayerProp(text), { playerName: name, propMarket: market });
  }
  check("shorthand: NFL parser still declines it (o/u prefix is shared, market is not)", parsePlayerProp("McDavid o3.5 SOG"), null);
  check("shorthand: pts over the hockey cap is not NHL", parseNhlPlayerProp("Jokic o25.5 pts"), null);
  check("shorthand: ast over the hockey cap is not NHL", parseNhlPlayerProp("Jokic o9.5 ast"), null);
  check("shorthand: a bare 'shots' with no line is not a market", parseNhlPlayerProp("Matthews shots"), null);
  check("shorthand: abbreviations can be disabled (header safety)", parseNhlPlayerProp("Sharp AGS", { abbreviations: false }), null);
  check("shorthand: o-prefix line reads back for grading", parsePlayerPropLine("McDavid o3.5 SOG"), { direction: "OVER", line: 3.5 });
  check("shorthand: u-prefix line reads back for grading", parsePlayerPropLine("Matthews u4.5 shots"), { direction: "UNDER", line: 4.5 });
  check("sport-less bare shots is GENERIC-unsupported (roster-recovered, not imported blind)", detectUnsupportedPropLine("Matthews over 4.5 shots")?.reason, UNSUPPORTED_PROP_REASONS.GENERIC);
  check("NHL-tagged bare shots is supported", detectUnsupportedPropLine("NHL Matthews over 4.5 shots"), null);
  check("team shots ('Arsenal over 5.5 shots') never imports as a player pick", parseCatalog("Krash\nArsenal over 5.5 shots").picks.length, 0);
  check("team-name-only shots total stays a team stat", detectUnsupportedPropLine("Oilers over 30.5 shots on goal")?.reason, UNSUPPORTED_PROP_REASONS.TEAM_STAT);
  check("team + team stays a team/game stat", detectUnsupportedPropLine("Oilers Flames over 60.5 shots on goal")?.reason, UNSUPPORTED_PROP_REASONS.TEAM_STAT);
  {
    const r = parseCatalog("Krash\nMcDavid ATGS");
    check("'McDavid ATGS' is not swallowed as a capper header (parked for roster recovery)", [r.picks.length, r.unresolved, r.unresolvedCapperNames], [0, ["McDavid ATGS"], ["Krash"]]);
    check("shorthand lines recover via the roster (Crosby FGS)", recovered1("Crosby FGS").sport, "NHL");
    check("shorthand lines recover via the roster (Crosby o3.5 SOG)", recovered1("Crosby o3.5 SOG").sport, "NHL");
    check("shorthand lines recover via the roster (Malkin over 0.5 ast)", recovered1("Malkin over 0.5 ast").sport, "NHL");
    check("shorthand lines recover via the roster (Crosby over 4.5 shots)", recovered1("Crosby over 4.5 shots").sport, "NHL");
  }

  // ---- team-prefixed lines -----------------------------------------------------
  {
    const r = parseCatalog("Krash\nOilers McDavid over 3.5 shots on goal");
    check("team-prefixed: imports as an NHL PLAYER_PROP with the team nickname", r.picks.map((x) => [x.sportName, x.betType, x.teamNicknames]), [["NHL", "PLAYER_PROP", ["oilers"]]]);
    check("team-prefixed: nothing unresolved", r.unresolved, []);
    check("team-prefixed: no longer flagged team stat", detectUnsupportedPropLine("Oilers McDavid over 3.5 shots on goal"), null);
    const a = parseCatalog("Krash\nOilers Draisaitl 2+ assists");
    check("team-prefixed N+ assists", a.picks.map((x) => [x.sportName, x.description]), [["NHL", "Oilers Draisaitl Over 1.5 assists"]]);
    const b = parseCatalog("Krash\nNHL Oilers McDavid anytime goal scorer");
    check("team-prefixed + NHL tag", b.picks.map((x) => [x.sportName, x.betType]), [["NHL", "PLAYER_PROP"]]);
    check("team-only shots total still a team stat total (no pick)", parseCatalog("Krash\nOilers over 30.5 shots on goal").picks.length, 0);
    check("matchup shots total still a game stat total (no pick)", parseCatalog("Krash\nOilers vs Flames over 60.5 shots on goal").picks.length, 0);
    check("NFL team-prefixed prop unaffected", parseCatalog("Krash\nChiefs Travis Kelce Over 42.5 Receiving Yards").picks.map((x) => [x.sportName, x.betType]), [["NFL", "PLAYER_PROP"]]);
  }

  // ---- NFL is byte-for-byte unchanged -------------------------------------
  check("NFL: passing yards", parsePlayerProp("Josh Allen Over 275.5 Passing Yards"), { playerName: "Josh Allen", propMarket: "PASS_YDS" });
  check("NFL: anytime TD", parsePlayerProp("Puka Nacua Anytime TD"), { playerName: "Puka Nacua", propMarket: "TD" });
  check("NFL: N+ receptions rewrite", normalizeNPlusPlayerProp("Zach Ertz 3+ receptions"), "Zach Ertz Over 2.5 receptions");
  check("NFL: 2+ TDs left alone", normalizeNPlusPlayerProp("Travis Kelce 2+ TDs"), "Travis Kelce 2+ TDs");
  check("NFL: parseAny prefers the NFL parser", parseAnyPlayerProp("Josh Allen Over 275.5 Passing Yards"), { playerName: "Josh Allen", propMarket: "PASS_YDS" });
  check("NFL text is never read as an NHL market", parseNhlPlayerProp("Josh Allen Over 275.5 Passing Yards"), null);
  check("NFL text is never read as an NHL market (TD)", parseNhlPlayerProp("Puka Nacua Anytime TD"), null);
  check("NHL text is not an NFL market", parsePlayerProp("Sidney Crosby over 3.5 shots on goal"), null);
  check("parseAny reads NHL when NFL declines", parseAnyPlayerProp("Sidney Crosby over 3.5 shots on goal"), { playerName: "Sidney Crosby", propMarket: "SHOTS_ON_GOAL" });
  check("parsePickText classifies an NHL prop as PLAYER_PROP", parsePickText("Sidney Crosby 4+ shots on goal").betType, "PLAYER_PROP");
  check("parsePickText stores the normalized Over line", parsePickText("Sidney Crosby 4+ shots on goal").cleanDescription, "Sidney Crosby Over 3.5 shots on goal");

  // ---- detectUnsupportedPropLine: NHL supported, everything else unchanged --
  check("supported NHL market is not flagged", detectUnsupportedPropLine("Sidney Crosby over 3.5 shots on goal"), null);
  check("supported NHL market with an NHL tag is not flagged", detectUnsupportedPropLine("NHL Sidney Crosby anytime goal scorer"), null);
  check("sport-less points stays GENERIC (basketball vocabulary too)", detectUnsupportedPropLine("Sidney Crosby over 0.5 points")?.reason, UNSUPPORTED_PROP_REASONS.GENERIC);
  check("NHL-tagged points is not flagged", detectUnsupportedPropLine("NHL Sidney Crosby over 0.5 points"), null);
  check("unsupported NHL market keeps the NHL reason", detectUnsupportedPropLine("NHL Brady Tkachuk over 3.5 hits")?.reason, UNSUPPORTED_PROP_REASONS.NHL);
  check("team shots total stays a team stat total", detectUnsupportedPropLine("Oilers over 30.5 shots on goal")?.reason, UNSUPPORTED_PROP_REASONS.TEAM_STAT);
  check("game shots total stays a game stat total", detectUnsupportedPropLine("Oilers vs Flames over 60.5 shots on goal")?.reason, UNSUPPORTED_PROP_REASONS.GAME_STAT);
  check("MLB saves (tagged MLB) stays MLB-unsupported", detectUnsupportedPropLine("MLB Devin Williams over 0.5 saves")?.reason, UNSUPPORTED_PROP_REASONS.MLB);
  check("MLB strikeouts stays MLB-unsupported", detectUnsupportedPropLine("Chris Sale over 5.5 K")?.reason, UNSUPPORTED_PROP_REASONS.MLB);
  check("NBA points stays NBA-unsupported", detectUnsupportedPropLine("NBA LeBron James over 25.5 points")?.reason, UNSUPPORTED_PROP_REASONS.NBA);

  // ---- parseCatalog: never dropped, never a total/ML/ATP -------------------
  {
    const r = parseCatalog("Krash\nNick Paul over 2.5 shots on goal\nDustin Wolf over 24.5 saves");
    check("tennis-surname collisions (Paul, Wolf) never become ATP picks", r.picks.length, 0);
    check("...they park in unresolved for roster recovery", r.unresolved, ["Nick Paul over 2.5 shots on goal", "Dustin Wolf over 24.5 saves"]);
    const named = parseCatalog("Krash\nNHL Sidney Crosby 4+ shots on goal");
    check("sport-tagged NHL prop imports as an NHL PLAYER_PROP with the Over line", named.picks.map((x) => [x.sportName, x.betType, x.description]), [["NHL", "PLAYER_PROP", "Sidney Crosby Over 3.5 shots on goal"]]);
    const header = parseCatalog("Saves Sam\nMLB Yankees ML");
    check("a capper named 'Saves Sam' stays a header", header.picks.map((x) => x.capperName), ["Saves Sam"]);
  }

  // ---- roster recovery ------------------------------------------------------
  check("full name resolves", recovered1("Sidney Crosby over 3.5 shots on goal"),
    { sport: "NHL", betType: "PLAYER_PROP", team: "pittsburgh penguins", desc: "Sidney Crosby over 3.5 shots on goal", still: 0 });
  check("bare surname resolves (unique)", recovered1("Crosby anytime goal scorer"),
    { sport: "NHL", betType: "PLAYER_PROP", team: "pittsburgh penguins", desc: "Crosby anytime goal scorer", still: 0 });
  check("N+ line resolves and stores the Over form", recovered1("Malkin 2+ assists").desc, "Malkin Over 1.5 assists");
  check("goalie saves resolves", recovered1("Arturs Silovs over 23.5 saves"),
    { sport: "NHL", betType: "PLAYER_PROP", team: "pittsburgh penguins", desc: "Arturs Silovs over 23.5 saves", still: 0 });
  check("first goal scorer resolves", recovered1("Koivunen first goal scorer").sport, "NHL");
  check("surname collision (two Johnsons) stays unresolved", recovered1("Johnson over 2.5 shots on goal"), { still: 1 });
  check("full name disambiguates the collision", recovered1("Jack Johnson over 2.5 shots on goal").team, "buffalo sabres");
  check("unknown player stays unresolved", recovered1("Zed Nobody over 2.5 shots on goal"), { still: 1 });
  check("points with a unique NHL roster hit is recovered as NHL", recovered1("Malkin over 0.5 points").sport, "NHL");
  check("basketball-sized points line never resolves to an NHL player", recovered1("Johnson over 24.5 points"), { still: 1 });
  check("an NBA-tagged line never resolves via the NHL roster", recovered1("NBA Erik Johnson over 0.5 points"), { still: 1 });
  check("MLB-tagged saves never resolves via the NHL roster", recovered1("MLB Dustin Wolf over 0.5 saves"), { still: 1 });
  check("team stat total is not recovered as a player prop", recovered1("Penguins over 30.5 shots on goal"), { still: 1 });
  check("empty NHL roster -> NHL lines stay unresolved (pre-NHL behavior)",
    recoverUnresolvedLines(["Sidney Crosby over 3.5 shots on goal"], ["Krash"], [], [], [], []).stillUnresolved, ["Sidney Crosby over 3.5 shots on goal"]);
  // An NFL line in the same recovery pass is unaffected by the NHL roster.
  {
    const nfl = [p("Jahmyr Gibbs", "Detroit Lions", "RB", "gibbs")];
    const r = recoverUnresolvedLines(["Gibbs over 65.5 rushing yards"], ["Krash"], [], nfl, [], roster);
    check("NFL bare-surname line still resolves against the NFL roster", r.recovered.map((x) => [x.sportName, x.teamNicknames[0]]), [["NFL", "detroit lions"]]);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
