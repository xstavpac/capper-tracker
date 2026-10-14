// Proof for NBA player-prop parsing and import - run with:
//   npx tsx src/lib/nba-prop-parsing-acceptance-test.ts
//
// No network, no database. Rosters are the real ones, captured from ESPN on
// 2026-10-13 with the app's own fetchers (fetchNbaLeagueRoster /
// fetchNhlLeagueRoster): 625 NBA players on 30 teams, 824 NHL players on 32.
//
//   PART A - the parser: every market, every shorthand and line form.
//   PART B - markets it recognizes but does not grade (triple-double, ...).
//   PART C - what is and is not an NBA prop at import; the regressions.
//   PART D - the roster pass: which player, and NBA vs NHL.
//   PART E - the sport-aware read of a stored pick (stamping, dedup).
//   PART F - nothing changed for NHL points / assists.
import fs from "node:fs";
import path from "node:path";
import { parseNbaProp, parseNbaPlayerProp, normalizeNbaNPlus, nbaDoubleDoubleSide, type NbaPropMarket } from "./nba-prop";
import { parseCatalog, parsePickText, parseSupportedNbaProp, detectUnsupportedPropLine, resolveAmbiguousPick, isPlayerAmbiguityKey } from "./parse-catalog";
import { recoverUnresolvedLines } from "./recover-unresolved-lines";
import { resolveNbaPropAgainstRosters } from "./nba-roster-fallback";
import { parseAnyPlayerProp, parsePlayerPropLine } from "./bet-line";
import { parseNhlPlayerProp } from "./nhl-prop";
import { dedupCategory } from "./duplicate-pick-detection";
import { runAmbiguousHierarchy } from "./ambiguous-hierarchy";
import { UNSUPPORTED_PROP_REASONS } from "./unsupported-prop-vocab";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const fixture = (name: string): RosterPlayer[] => JSON.parse(fs.readFileSync(path.join(__dirname, "../server/data/__fixtures__", name), "utf8"));
const NBA = fixture("nba-league-roster-2026-10-13.json");
const NHL = fixture("nhl-league-roster-2026-10-13.json");
const nbaTeamOf = (name: string) => NBA.find((p) => p.playerName === name)!.team.toLowerCase();
const nhlTeamOf = (name: string) => NHL.find((p) => p.playerName === name)!.team.toLowerCase();

// One pasted line through the real import: parseCatalog, then the roster pass.
function importLine(line: string, opts: { nba?: RosterPlayer[]; nhl?: RosterPlayer[]; header?: string } = {}) {
  const parsed = parseCatalog(`Cap\n${opts.header ? opts.header + "\n" : ""}${line}`, []);
  const rec = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, [], [], parsed.picks, opts.nhl ?? NHL, [], [], opts.nba ?? NBA, parsed.unresolvedLeagues);
  return { parsed, rec };
}
// What became of the line, in one comparable value.
type Outcome = { sport?: string; betType?: string; team?: string[]; desc?: string; asks?: string[]; unresolved?: string | null; nothing?: true };
function outcome(line: string, opts: Parameters<typeof importLine>[1] = {}): Outcome {
  const { parsed, rec } = importLine(line, opts);
  const pick = parsed.picks[0] ?? rec.recovered[0];
  if (pick?.ambiguous) return { asks: pick.ambiguous.map((o) => o.label), betType: pick.betType };
  if (pick) return { sport: pick.sportName, betType: pick.betType, team: pick.teamNicknames, desc: pick.description };
  if (rec.stillUnresolved.length) return { unresolved: rec.reasons[rec.stillUnresolved[0]] ?? null };
  return { nothing: true };
}

async function main() {
  console.log("########## PART A: the parser ##########");
  {
    const cases: [string, NbaPropMarket, string][] = [
      // points
      ["Brunson over 24.5 points", "POINTS", "Brunson"],
      ["Brunson o24.5 pts", "POINTS", "Brunson"],
      ["Brunson o 24.5 points", "POINTS", "Brunson"],
      ["Brunson under 24.5 points", "POINTS", "Brunson"],
      ["Brunson u24.5 pts", "POINTS", "Brunson"],
      ["Brunson 25+ points", "POINTS", "Brunson"],
      ["BRUNSON OVER 24.5 POINTS", "POINTS", "BRUNSON"],
      ["Nikola Jokic O 25.5 Pts", "POINTS", "Nikola Jokic"],
      // rebounds
      ["Jokic over 12.5 rebounds", "REBOUNDS", "Jokic"],
      ["Jokic o12.5 rebs", "REBOUNDS", "Jokic"],
      ["Jokic o12.5 reb", "REBOUNDS", "Jokic"],
      ["Jokic 13+ boards", "REBOUNDS", "Jokic"],
      // assists
      ["Jokic over 9.5 assists", "ASSISTS", "Jokic"],
      ["Jokic o9.5 ast", "ASSISTS", "Jokic"],
      ["Jokic 10+ asts", "ASSISTS", "Jokic"],
      // threes
      ["Curry over 4.5 threes", "THREES_MADE", "Curry"],
      ["Paul o2.5 3pm", "THREES_MADE", "Paul"],
      ["Curry 5+ 3s", "THREES_MADE", "Curry"],
      ["Curry o4.5 3pt", "THREES_MADE", "Curry"],
      ["Curry over 4.5 3-pointers", "THREES_MADE", "Curry"],
      ["Curry over 4.5 3 pointers", "THREES_MADE", "Curry"],
      ["Curry over 4.5 three pointers", "THREES_MADE", "Curry"],
      ["Curry over 4.5 made threes", "THREES_MADE", "Curry"],
      // steals / blocks
      ["Caruso over 1.5 steals", "STEALS", "Caruso"],
      ["Caruso o1.5 stl", "STEALS", "Caruso"],
      ["Wembanyama over 3.5 blocks", "BLOCKS", "Wembanyama"],
      ["Wembanyama o3.5 blk", "BLOCKS", "Wembanyama"],
      // points + rebounds + assists
      ["Tatum PRA o38.5", "POINTS_REBOUNDS_ASSISTS", "Tatum"],
      ["Tatum 39+ PRA", "POINTS_REBOUNDS_ASSISTS", "Tatum"],
      ["Tatum over 38.5 pts+reb+ast", "POINTS_REBOUNDS_ASSISTS", "Tatum"],
      ["Tatum o38.5 points rebounds assists", "POINTS_REBOUNDS_ASSISTS", "Tatum"],
      ["Tatum over 38.5 points + rebounds + assists", "POINTS_REBOUNDS_ASSISTS", "Tatum"],
      ["Tatum o38.5 p+r+a", "POINTS_REBOUNDS_ASSISTS", "Tatum"],
      // points + rebounds
      ["Embiid P+R over 40.5", "POINTS_REBOUNDS", "Embiid"],
      ["Embiid PR o40.5", "POINTS_REBOUNDS", "Embiid"],
      ["Embiid o40.5 PR", "POINTS_REBOUNDS", "Embiid"],
      ["Embiid 41+ PR", "POINTS_REBOUNDS", "Embiid"],
      ["Embiid over 40.5 pts+reb", "POINTS_REBOUNDS", "Embiid"],
      ["Embiid over 40.5 points and rebounds", "POINTS_REBOUNDS", "Embiid"],
      ["Anthony Edwards o25.5 PTS + REB", "POINTS_REBOUNDS", "Anthony Edwards"],
      // points + assists
      ["Haliburton P+A u30.5", "POINTS_ASSISTS", "Haliburton"],
      ["Haliburton PA o30.5", "POINTS_ASSISTS", "Haliburton"],
      ["Haliburton over 30.5 pts+ast", "POINTS_ASSISTS", "Haliburton"],
      ["Haliburton over 30.5 points and assists", "POINTS_ASSISTS", "Haliburton"],
      // rebounds + assists
      ["Sabonis R+A o19.5", "REBOUNDS_ASSISTS", "Sabonis"],
      ["Sabonis RA o19.5", "REBOUNDS_ASSISTS", "Sabonis"],
      ["Sabonis over 19.5 reb+ast", "REBOUNDS_ASSISTS", "Sabonis"],
      ["Sabonis over 19.5 rebounds and assists", "REBOUNDS_ASSISTS", "Sabonis"],
      // double-double (no line)
      ["Jokic double-double", "DOUBLE_DOUBLE", "Jokic"],
      ["Jokic double double", "DOUBLE_DOUBLE", "Jokic"],
      ["Jokic DD", "DOUBLE_DOUBLE", "Jokic"],
      ["Jokic to record a double double", "DOUBLE_DOUBLE", "Jokic"],
      ["Jokic no double-double", "DOUBLE_DOUBLE", "Jokic"],
      // odds, stake and parentheses around it
      ["Steph Curry (GSW) o4.5 3pm -115 1u", "THREES_MADE", "Steph Curry"],
      ["Karl-Anthony Towns o11.5 reb -115 2u", "REBOUNDS", "Karl Anthony Towns"],
      ["Jokic double double (+120) 2u", "DOUBLE_DOUBLE", "Jokic"],
    ];
    for (const [text, market, name] of cases) {
      check(`"${text}" -> ${market} for "${name}"`, parseNbaPlayerProp(text), { playerName: name, propMarket: market });
    }

    // The threshold form becomes the Over line every later reader understands.
    check('"Brunson 25+ points" -> "Brunson Over 24.5 points"', normalizeNbaNPlus("Brunson 25+ points"), "Brunson Over 24.5 points");
    check('"Curry 5+ 3s" -> "Curry Over 4.5 3s"', normalizeNbaNPlus("Curry 5+ 3s"), "Curry Over 4.5 3s");
    check('"Tatum 39+ PRA" -> "Tatum Over 38.5 PRA"', normalizeNbaNPlus("Tatum 39+ PRA"), "Tatum Over 38.5 PRA");
    check("the + inside P+R is not a threshold", normalizeNbaNPlus("Embiid P+R over 40.5"), "Embiid P+R over 40.5");
    check("an N+ before a non-NBA word is untouched", normalizeNbaNPlus("Lakers 3+ game win streak"), "Lakers 3+ game win streak");
    check("text with its own over/under number is untouched", normalizeNbaNPlus("Brunson over 24.5 points 3+ units"), "Brunson over 24.5 points 3+ units");
    check("the rewritten line reads as Over 24.5", parsePlayerPropLine(normalizeNbaNPlus("Brunson 25+ points")), { direction: "OVER", line: 24.5 });

    check("double-double is YES unless the text says no", [nbaDoubleDoubleSide("Jokic double-double"), nbaDoubleDoubleSide("Jokic no double-double"), nbaDoubleDoubleSide("Jokic double-double: no")], ["YES", "NO", "NO"]);

    // Not an NBA prop at all.
    for (const text of ["Lakers -3.5", "Lakers ML", "Lakers over 220.5", "over 220.5", "Jokic ML", "Brunson points", "Jokic rebounds"]) {
      check(`"${text}" is not an NBA prop`, parseNbaProp(text), null);
    }
    // Bare PR / PA / RA are a market only flush against a line, after a name.
    for (const text of ["PR Picks", "Embiid PR", "PA Sharp 10-2", "RA Capper", "PR o40.5"]) {
      check(`bare letters "${text}" are not a market`, parseNbaProp(text), null);
    }
    // "DD" only as the closing word after a name; "double double" needs a name before it.
    check('"DD Picks" is not a double-double', parseNbaProp("DD Picks"), null);
    check('"Double Double Picks" names nobody', parseNbaProp("Double Double Picks"), null);
    check("with abbreviations off, DD is not read", parseNbaProp("Jokic DD", { abbreviations: false }), null);
  }

  console.log("\n########## PART B: recognized, not graded ##########");
  {
    for (const text of [
      "Jokic triple-double",
      "Jokic triple double",
      "Jokic first basket",
      "Jokic 1st quarter over 7.5 points",
      "Jokic 1H o12.5 pts",
      "Jokic o1.5 stl+blk",
      "Jokic over 1.5 steals + blocks",
      "Jokic o30.5 pts+stl",
      "Jokic over 3.5 turnovers",
      "Jokic over 22.5 fantasy points",
    ]) {
      const prop = parseNbaProp(text);
      check(`"${text}" is an NBA prop with NO market and an unsupported reason`, { name: prop?.playerName, market: prop?.propMarket ?? null, flagged: Boolean(prop?.unsupported) }, { name: "Jokic", market: null, flagged: true });
      check(`"${text}" is never returned as a supported market`, parseNbaPlayerProp(text), null);
    }
    // The two shapes most likely to be misread as a supported one.
    check("triple-double is not a double-double", parseNbaProp("Jokic triple-double")?.propMarket, null);
    check("a quarter-scoped points line is not full-game POINTS", parseNbaProp("Jokic 1st quarter over 7.5 points")?.propMarket, null);

    // At import: a player prop, never a moneyline or a total, never a capper header.
    check('"Jokic triple-double" is a PLAYER_PROP, not a moneyline', parsePickText("Jokic triple-double").betType, "PLAYER_PROP");
    check('"Jokic 1st quarter over 7.5 points" is a PLAYER_PROP, not a total', parsePickText("Jokic 1st quarter over 7.5 points").betType, "PLAYER_PROP");
    check('"Jokic triple-double" imports as an NBA PLAYER_PROP on his team', outcome("Jokic triple-double"), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("Nikola Jokic")], desc: "Jokic triple-double" });
    check('"NBA Jokic triple double" does too (it used to be a MONEYLINE)', outcome("NBA Jokic triple double"), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("Nikola Jokic")], desc: "Jokic triple double" });
    // It carries no market, so the stamp is empty - nothing can grade it as something else.
    check("an ungraded NBA prop gets no propMarket stamp", parseAnyPlayerProp("Jokic triple-double", "NBA"), null);
  }

  console.log("\n########## PART C: what is an NBA prop at import ##########");
  {
    // A person, no team: parked for the roster pass (never imported sport-less).
    for (const line of ["Brunson 25+ points", "Tatum PRA o38.5", "Embiid P+R over 40.5", "Jokic double-double", "Paul o2.5 3pm", "NBA Jokic over 10.5 rebounds", "Jokic over 10.5 rebounds NBA"]) {
      const parsed = parseCatalog(`Cap\n${line}`, []);
      check(`"${line}" is parked: one unresolved line, no pick, not flagged unsupported`, { unresolved: parsed.unresolved, picks: parsed.picks.length, flagged: detectUnsupportedPropLine(line) }, { unresolved: [line], picks: 0, flagged: null });
    }
    // An NBA team in front of the player: imports directly, with that team.
    check('"Lakers LeBron James over 7.5 rebounds" imports directly', outcome("Lakers LeBron James over 7.5 rebounds"), { sport: "NBA", betType: "PLAYER_PROP", team: ["lakers"], desc: "Lakers LeBron James over 7.5 rebounds" });
    check('"Nuggets Jokic 10+ assists" imports directly, threshold rewritten', outcome("Nuggets Jokic 10+ assists"), { sport: "NBA", betType: "PLAYER_PROP", team: ["nuggets"], desc: "Nuggets Jokic Over 9.5 assists" });
    check("team-prefixed is the 'team' subject", parseSupportedNbaProp("Lakers LeBron James over 7.5 rebounds")?.subject, "team");
    check("a full team name in front works the same", outcome("Los Angeles Lakers LeBron James over 25.5 points"), { sport: "NBA", betType: "PLAYER_PROP", team: ["lakers"], desc: "Los Angeles Lakers LeBron James over 25.5 points" });
    check("a two-word nickname in front", outcome("Trail Blazers Scoot Henderson o5.5 ast").team, ["trail blazers"]);
    check("a team-prefixed ungraded market is still a player prop", outcome("Lakers LeBron triple-double"), { sport: "NBA", betType: "PLAYER_PROP", team: ["lakers"], desc: "Lakers LeBron triple-double" });
    // A team plus more of the BET is the team's own line, not a player's.
    for (const [line, betType] of [
      ["Lakers team total over 110.5 points", "TEAM_TOTAL"],
      ["Lakers TT o110.5 points", "TEAM_TOTAL"],
      ["Lakers Alt over 215.5 points", "TOTAL"],
      ["Lakers Game over 220.5 points", "TOTAL"],
      ["Thunder -6.5 and over 220.5 points", "TOTAL"],
      // An unlisted word beside the team, but no player scores 220.5.
      ["Lakers Showtime over 220.5 points", "TOTAL"],
    ] as const) {
      const pick = parseCatalog(`Cap\n${line}`, []).picks[0];
      check(`"${line}" is the team's own ${betType}, not a player prop`, { nba: parseSupportedNbaProp(line), sport: pick?.sportName, betType: pick?.betType }, { nba: null, sport: "NBA", betType });
    }

    // ---- regressions: these are NOT NBA props ----
    const mlb = parseCatalog("Cap\nYankees o8.5 3pm", []).picks[0];
    check('"Yankees o8.5 3pm" stays an MLB total', { sport: mlb?.sportName, betType: mlb?.betType }, { sport: "MLB", betType: "TOTAL" });
    check('"Yankees o8.5 3pm" is not an NBA prop', parseSupportedNbaProp("Yankees o8.5 3pm"), null);
    const ny = parseCatalog("Cap\nNew York over 44.5 points", []).picks[0];
    check('"New York over 44.5 points" is not an NBA prop: still the ambiguous city', { nba: parseSupportedNbaProp("New York over 44.5 points"), key: ny?.ambiguousKey, betType: ny?.ambiguousBetType }, { nba: null, key: "new york", betType: "TOTAL" });
    const nyResolved = await runAmbiguousHierarchy([ny], {}, { runScheduleCheck: async () => ({}), runWideScheduleCheck: async () => ({}), now: new Date("2026-11-10T16:00:00Z") });
    check('"New York over 44.5 points" in November never resolves to the NBA', nyResolved.picks[0].sportName === "NBA", false);
    const lakers = parseCatalog("Cap\nLakers over 220.5 points", []).picks[0];
    check('"Lakers over 220.5 points" stays an NBA game total', { sport: lakers?.sportName, betType: lakers?.betType }, { sport: "NBA", betType: "TOTAL" });
    const matchup = parseCatalog("Cap\nNBA Lakers vs Nuggets over 220.5 pts", []).picks[0];
    check('"NBA Lakers vs Nuggets over 220.5 pts" stays a game total', { sport: matchup?.sportName, betType: matchup?.betType }, { sport: "NBA", betType: "TOTAL" });
    check('"Lakers over 45.5 rebounds" is still a team stat total', detectUnsupportedPropLine("Lakers over 45.5 rebounds")?.reason, UNSUPPORTED_PROP_REASONS.TEAM_STAT);
    check('"Boston over 215.5 points" is not an NBA prop', parseSupportedNbaProp("Boston over 215.5 points"), null);
    check('"Detroit Pistons over 110.5 points" is not an NBA prop', parseSupportedNbaProp("Detroit Pistons over 110.5 points"), null);
    const pistons = parseCatalog("Cap\nDetroit Pistons over 110.5 points", []).picks[0];
    check('"Detroit Pistons over 110.5 points" still resolves to the Pistons', { sport: pistons?.sportName, teams: pistons?.teamNicknames }, { sport: "NBA", teams: ["pistons"] });
    // Another league's code is that league's line.
    check('"NHL Connor McDavid over 1.5 points" is not an NBA prop', parseSupportedNbaProp("NHL Connor McDavid over 1.5 points"), null);
    check('"WNBA A\'ja Wilson over 9.5 rebounds" keeps the WNBA reason', detectUnsupportedPropLine("WNBA A'ja Wilson over 9.5 rebounds")?.reason, UNSUPPORTED_PROP_REASONS.WNBA);
    check("an NFL prop is untouched", [parseSupportedNbaProp("Josh Allen Over 275.5 Passing Yards"), parsePickText("Josh Allen Over 275.5 Passing Yards").betType], [null, "PLAYER_PROP"]);

    // ---- tennis exclusion ----
    const paul = parseCatalog("Cap\nPaul o2.5 3pm", []);
    check('"Paul o2.5 3pm" is not an ATP pick (Paul is a tennis surname)', paul.picks.some((p) => p.sportName === "ATP"), false);
    check('"Paul ML" is still an ATP pick', parseCatalog("Cap\nPaul ML", []).picks[0]?.sportName, "ATP");
    check('"Fritz over 22.5 games" is still an ATP pick', parseCatalog("Cap\nFritz over 22.5 games", []).picks[0]?.sportName, "ATP");
    // No NBA player is surnamed Paul on these rosters, so the line stays unresolved with the reason.
    check('"Paul o2.5 3pm" after the roster pass: unresolved, with why', outcome("Paul o2.5 3pm"), { unresolved: 'couldn\'t find "Paul" on an NBA roster' });
    check('"Paul George over 2.5 3s" resolves to Paul George', outcome("Paul George over 2.5 3s"), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("Paul George")], desc: "Paul George over 2.5 3s" });

    // ---- headers are still headers ----
    const header = parseCatalog("Double Double Picks\nLakers -3", []);
    check('"Double Double Picks" is still a capper header', { capper: header.picks[0]?.capperName, unresolved: header.unresolved }, { capper: "Double Double Picks", unresolved: [] });
  }

  console.log("\n########## PART D: the roster pass - which player, which league ##########");
  {
    const jokic = nbaTeamOf("Nikola Jokic");
    // ---- the examples from the spec ----
    check('"Brunson 25+ points"', outcome("Brunson 25+ points"), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("Jalen Brunson")], desc: "Brunson Over 24.5 points" });
    check('"Tatum PRA o38.5"', outcome("Tatum PRA o38.5"), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("Jayson Tatum")], desc: "Tatum PRA o38.5" });
    check('"Embiid P+R over 40.5"', outcome("Embiid P+R over 40.5"), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("Joel Embiid")], desc: "Embiid P+R over 40.5" });
    check('"Jokic double-double"', outcome("Jokic double-double"), { sport: "NBA", betType: "PLAYER_PROP", team: [jokic], desc: "Jokic double-double" });

    // ---- NBA vs NHL on the shared markets ----
    check("an NBA-only player resolves NBA", outcome("Jokic over 9.5 assists"), { sport: "NBA", betType: "PLAYER_PROP", team: [jokic], desc: "Jokic over 9.5 assists" });
    check("an NHL-only player resolves NHL", outcome("McDavid over 1.5 points"), { sport: "NHL", betType: "PLAYER_PROP", team: [nhlTeamOf("Connor McDavid")], desc: "McDavid over 1.5 points" });
    check("a full NHL name resolves NHL", outcome("Connor McDavid over 0.5 assists"), { sport: "NHL", betType: "PLAYER_PROP", team: [nhlTeamOf("Connor McDavid")], desc: "Connor McDavid over 0.5 assists" });
    // "Fox": De'Aaron Fox (NBA) and Adam Fox (NHL) - one each, so the name is on both rosters.
    check("a name on BOTH rosters asks, with each league's player", outcome("Fox over 1.5 assists"), { asks: ["De'Aaron Fox — Spurs G (NBA)", "Adam Fox — Rangers D (NHL)"], betType: "PLAYER_PROP" });
    check("...whatever the line: it is never settled by the number alone", outcome("Fox over 24.5 points"), { asks: ["De'Aaron Fox — Spurs G (NBA)", "Adam Fox — Rangers D (NHL)"], betType: "PLAYER_PROP" });
    check("the full name settles it: De'Aaron Fox is NBA", outcome("De'Aaron Fox over 6.5 assists"), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("De'Aaron Fox")], desc: "De'Aaron Fox over 6.5 assists" });
    check("the full name settles it: Adam Fox is NHL", outcome("Adam Fox over 0.5 assists"), { sport: "NHL", betType: "PLAYER_PROP", team: [nhlTeamOf("Adam Fox")], desc: "Adam Fox over 0.5 assists" });
    // A roster hit beats the cap: 2.5 assists is a hockey-sized number, Jokic is not a hockey player.
    check("a roster hit beats the line cap (NBA player, hockey-sized line)", outcome("Jokic over 2.5 assists"), { sport: "NBA", betType: "PLAYER_PROP", team: [jokic], desc: "Jokic over 2.5 assists" });
    // The roster says hockey, the number says it can't be: not silently accepted either way.
    check("an NHL player with a basketball-sized line is left unresolved, with why", outcome("McDavid over 24.5 points"), {
      unresolved: "Connor McDavid is an NHL player, but 24.5 points is not a hockey line (NHL points lines stop at 3.5) - check the player or the league",
    });
    check("...same for assists", outcome("Connor McDavid over 8.5 assists"), {
      unresolved: "Connor McDavid is an NHL player, but 8.5 assists is not a hockey line (NHL assists lines stop at 2.5) - check the player or the league",
    });
    check("a name on neither roster stays unresolved", outcome("Zed Nobody over 9.5 points"), { unresolved: 'couldn\'t find "Zed Nobody" on an NBA or NHL roster' });
    check("...and a WNBA player is on neither", outcome("A'ja Wilson over 18.5 points"), { unresolved: 'couldn\'t find "A\'ja Wilson" on an NBA or NHL roster' });

    // ---- markets only basketball has: no NHL check ----
    check("rebounds never consults the NHL roster: Fox is De'Aaron", outcome("Fox over 4.5 rebounds"), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("De'Aaron Fox")], desc: "Fox over 4.5 rebounds" });
    check("an NHL player on a basketball-only market is unresolved (Makar blocks)", outcome("Makar over 2.5 blocks"), { unresolved: 'couldn\'t find "Makar" on an NBA roster' });
    check("a name on no NBA roster, basketball-only market", outcome("Zed Nobody over 9.5 rebounds"), { unresolved: 'couldn\'t find "Zed Nobody" on an NBA roster' });

    // ---- an explicit league wins ----
    check('"NBA Fox over 1.5 assists": the code settles it, no prompt', outcome("NBA Fox over 1.5 assists"), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("De'Aaron Fox")], desc: "Fox over 1.5 assists" });
    check("a trailing code works too, and is dropped from the stored text", outcome("Jokic over 10.5 rebounds NBA"), { sport: "NBA", betType: "PLAYER_PROP", team: [jokic], desc: "Jokic over 10.5 rebounds" });
    // The capper's own sub-header.
    check('under an "NBA" sub-header, Fox is De\'Aaron', outcome("Fox over 1.5 assists", { header: "NBA" }), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("De'Aaron Fox")], desc: "Fox over 1.5 assists" });
    check('under an "NHL" sub-header, Fox is Adam', outcome("Fox over 0.5 assists", { header: "NHL" }), { sport: "NHL", betType: "PLAYER_PROP", team: [nhlTeamOf("Adam Fox")], desc: "Fox over 0.5 assists" });
    check('under an "NHL" sub-header the cap still objects', outcome("Fox over 6.5 assists", { header: "NHL" }), {
      unresolved: "Adam Fox is an NHL player, but 6.5 assists is not a hockey line (NHL assists lines stop at 2.5) - check the player or the league",
    });
    {
      // The sub-header belongs to its capper only.
      const parsed = parseCatalog("Sharp Guy\nNBA\nFox over 1.5 assists\n\nOther Guy\nFox over 1.5 assists", []);
      check("a sub-header's league is recorded for its own capper's lines only", parsed.unresolvedLeagues, { 0: "NBA" });
    }

    // ---- name tiers, same as NFL / NHL ----
    check("a hyphenated full name", outcome("Shai Gilgeous-Alexander over 30.5 points").sport, "NBA");
    check("an apostrophe and initials", [outcome("De'Aaron Fox o24.5 pts").sport, outcome("PJ Washington over 6.5 rebounds").team], ["NBA", [nbaTeamOf("P.J. Washington")]]);
    check("a generational suffix on the roster, not in the text", outcome("Trey Murphy over 2.5 threes").team, [nbaTeamOf("Trey Murphy III")]);
    check("odds and a bare stake after the line", outcome("Karl-Anthony Towns o11.5 reb -115 2u"), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("Karl-Anthony Towns")], desc: "Karl-Anthony Towns o11.5 reb" });
    // A surname several NBA players share is asked, never guessed (three Jameses, no NHL James).
    const james = outcome("James over 24.5 points");
    check("a surname shared inside the NBA asks which player", { n: james.asks?.length ?? 0, allJames: (james.asks ?? []).every((l) => /James — /.test(l)), tagged: (james.asks ?? []).some((l) => /\((?:NBA|NHL)\)/.test(l)) }, { n: NBA.filter((p) => p.lastName === "James").length, allJames: true, tagged: false });
    check("the full name skips the question", outcome("LeBron James o24.5 pts").team, [nbaTeamOf("LeBron James")]);
    // An initialism the alias map knows is that player (nba-player-aliases.ts); one it doesn't is still unresolved.
    check("a known initialism is its player: SGA", outcome("SGA over 30.5 points").team, [nbaTeamOf("Shai Gilgeous-Alexander")]);
    check("an unknown initialism is not a name: unresolved", outcome("XYZ over 30.5 points"), { unresolved: 'couldn\'t find "XYZ" on an NBA or NHL roster' });

    // ---- a lowercase name ----
    check("a lowercase name resolves, and is capitalized in the stored text", outcome("jokic o10.5 reb"), { sport: "NBA", betType: "PLAYER_PROP", team: [jokic], desc: "Jokic o10.5 reb" });
    check("a lowercase threshold line is rewritten too", outcome("brunson 25+ points"), { sport: "NBA", betType: "PLAYER_PROP", team: [nbaTeamOf("Jalen Brunson")], desc: "Brunson Over 24.5 points" });
    {
      // A lowercase word no roster knows was never positively a prop: it goes on to the team resolvers.
      const parsed = parseCatalog("Cap\nfurman over 50.5 points", []);
      const rec = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, [{ sport: "NCAAF", name: "Furman Paladins" }, { sport: "NCAAF", name: "Wofford Terriers" }], [], parsed.picks, NHL, [], [], NBA, parsed.unresolvedLeagues);
      check('"furman over 50.5 points" still resolves to the live Furman game', rec.recovered.map((p) => [p.sportName, p.betType, p.teamNicknames]), [["NCAAF", "TOTAL", ["furman paladins"]]]);
    }

    // ---- answering the question ----
    {
      const { rec } = importLine("Fox over 1.5 assists");
      const pending = rec.recovered[0];
      check("the pending pick is a player question only the user settles", { key: isPlayerAmbiguityKey(pending.ambiguousKey ?? ""), sport: pending.sportName, teams: pending.teamNicknames }, { key: true, sport: "", teams: [] });
      const auto = await runAmbiguousHierarchy([pending], {}, { runScheduleCheck: async () => ({}), runWideScheduleCheck: async () => ({}), now: new Date("2026-11-10T16:00:00Z") });
      check("the schedule / season / context steps never answer it", auto.picks[0].sportName, "");
      const nbaChoice = resolveAmbiguousPick(pending, pending.ambiguous!.find((o) => o.sport === "NBA")!);
      check("choosing De'Aaron Fox makes it an NBA pick on the Spurs", { sport: nbaChoice.sportName, betType: nbaChoice.betType, teams: nbaChoice.teamNicknames, desc: nbaChoice.description }, { sport: "NBA", betType: "PLAYER_PROP", teams: ["san antonio spurs"], desc: "Fox over 1.5 assists" });
      const nhlChoice = resolveAmbiguousPick(pending, pending.ambiguous!.find((o) => o.sport === "NHL")!);
      check("choosing Adam Fox makes it an NHL pick on the Rangers", { sport: nhlChoice.sportName, betType: nhlChoice.betType, teams: nhlChoice.teamNicknames }, { sport: "NHL", betType: "PLAYER_PROP", teams: ["new york rangers"] });
    }

    // ---- the rule itself, in isolation ----
    {
      const prop = parseNbaProp("Fox over 1.5 assists")!;
      const base = { nbaRoster: NBA, nhlRoster: NHL, league: null } as const;
      check("rule: both rosters hit -> ask", resolveNbaPropAgainstRosters("Fox over 1.5 assists", prop, base).status, "ask");
      check("rule: league NBA -> NBA only", resolveNbaPropAgainstRosters("Fox over 1.5 assists", prop, { ...base, league: "NBA" }), { status: "resolved", sport: "NBA", team: "San Antonio Spurs", playerName: "De'Aaron Fox" });
      check("rule: league NHL -> NHL only", resolveNbaPropAgainstRosters("Fox over 1.5 assists", prop, { ...base, league: "NHL" }), { status: "resolved", sport: "NHL", team: "New York Rangers", playerName: "Adam Fox" });
      check("rule: an empty NHL roster means NBA alone can answer", resolveNbaPropAgainstRosters("Fox over 1.5 assists", prop, { ...base, nhlRoster: [] }).status, "resolved");
      // A complete slate on which only one same-surname NBA player's team plays settles it (same tiebreak as NFL).
      const james = parseNbaProp("James over 24.5 points")!;
      const lebron = NBA.find((p) => p.playerName === "LeBron James")!;
      check("rule: a complete slate with one James playing resolves him", resolveNbaPropAgainstRosters("James over 24.5 points", james, { ...base, nbaSlate: { teams: [lebron.team], complete: true } }), { status: "resolved", sport: "NBA", team: lebron.team, playerName: "LeBron James" });
      check("rule: an incomplete slate does not", resolveNbaPropAgainstRosters("James over 24.5 points", james, { ...base, nbaSlate: { teams: [lebron.team], complete: false } }).status, "ask");
    }

    // ---- no NBA roster to read (not loaded yet / read failed) ----
    check("no NBA roster: an NBA prop is unresolved, with why", outcome("Jokic over 10.5 rebounds", { nba: [] }), { unresolved: "NBA player props need the NBA roster, which isn't available right now" });
    check("no NBA roster: an NBA-coded line too", outcome("NBA Jokic over 10.5 assists", { nba: [] }), { unresolved: "NBA player props need the NBA roster, which isn't available right now" });
    check("no NBA roster: NHL points still resolve exactly as before", outcome("McDavid over 1.5 points", { nba: [] }), { sport: "NHL", betType: "PLAYER_PROP", team: [nhlTeamOf("Connor McDavid")], desc: "McDavid over 1.5 points" });
  }

  console.log("\n########## PART E: the sport-aware read of a stored pick ##########");
  {
    // What bulk-picks stamps on the row: parseAnyPlayerProp(description, sportName).
    check("an NBA pick is read by the NBA parser", parseAnyPlayerProp("Jokic over 10.5 rebounds", "NBA"), { playerName: "Jokic", propMarket: "REBOUNDS" });
    check("NBA assists with a hockey-sized line is still NBA ASSISTS", parseAnyPlayerProp("Jokic over 2.5 assists", "NBA"), { playerName: "Jokic", propMarket: "ASSISTS" });
    check("NBA points above the hockey cap", parseAnyPlayerProp("Brunson Over 24.5 points", "nba"), { playerName: "Brunson", propMarket: "POINTS" });
    check("NBA PRA", parseAnyPlayerProp("Tatum PRA o38.5", "NBA")?.propMarket, "POINTS_REBOUNDS_ASSISTS");
    // Every other sport, and no sport at all, reads exactly as before: never a basketball market.
    check("an NHL pick is never stamped with a basketball market", [parseAnyPlayerProp("McDavid over 1.5 points", "NHL")?.propMarket, parseAnyPlayerProp("McDavid over 7.5 rebounds", "NHL")], ["POINTS", null]);
    check("no sport (a legacy row) reads as before", [parseAnyPlayerProp("McDavid over 1.5 points")?.propMarket, parseAnyPlayerProp("Jokic over 10.5 rebounds"), parseAnyPlayerProp("Josh Allen Over 275.5 Passing Yards")?.propMarket], ["POINTS", null, "PASS_YDS"]);
    check("an NFL / MLB pick reads as before with its sport passed", [parseAnyPlayerProp("Josh Allen Over 275.5 Passing Yards", "NFL")?.propMarket, parseAnyPlayerProp("Chris Sale over 5.5 Ks", "MLB")?.propMarket], ["PASS_YDS", "STRIKEOUTS"]);

    // Dedup: with the sport, two NBA props on one game are told apart by market and player.
    const key = (detail: string, sport?: string) => dedupCategory("TD_PROP", "PLAYER_PROP", detail, null, null, sport);
    check("NBA dedup key carries market and player", key("Jokic over 10.5 rebounds", "NBA"), "TD_PROP:REBOUNDS:jokic");
    check("two players' rebounds props are different bets", key("Jokic over 10.5 rebounds", "NBA") === key("Murray over 4.5 rebounds", "NBA"), false);
    check("one player's rebounds and assists props are different bets", key("Jokic over 10.5 rebounds", "NBA") === key("Jokic over 9.5 assists", "NBA"), false);
    check("the same prop pasted twice is the same bet", key("Jokic over 10.5 rebounds", "NBA") === key("Jokic over 10.5 rebounds", "NBA"), true);
    check("a pasted pick and its stored row agree", key("Jokic over 10.5 rebounds", "NBA"), dedupCategory("TD_PROP", "PLAYER_PROP", "Jokic over 10.5 rebounds", null, { propMarket: "REBOUNDS", playerName: "Jokic" }, "NBA"));
    check("an ungraded NBA prop is still keyed by player", [key("Jokic triple-double", "NBA"), key("Murray triple-double", "NBA")], ["TD_PROP:UNGRADED:jokic", "TD_PROP:UNGRADED:murray"]);
    // NHL keys are unchanged, with or without the sport.
    check("NHL dedup key is unchanged", [key("McDavid over 1.5 points", "NHL"), key("McDavid over 1.5 points")], ["TD_PROP:POINTS:mcdavid", "TD_PROP:POINTS:mcdavid"]);
  }

  console.log("\n########## PART F: NHL points / assists, unchanged ##########");
  {
    // The sport-blind NHL parser and its caps are exactly what they were.
    check("NHL parser: low points line", parseNhlPlayerProp("Connor McDavid over 1.5 points"), { playerName: "Connor McDavid", propMarket: "POINTS" });
    check("NHL parser: a line above the cap is still not hockey", [parseNhlPlayerProp("Connor McDavid over 24.5 points"), parseNhlPlayerProp("Connor McDavid over 8.5 assists")], [null, null]);
    // NHL lines that never involved basketball vocabulary go the way they always did, NBA roster loaded or not.
    for (const nba of [NBA, []]) {
      const tag = nba.length ? "NBA roster loaded" : "no NBA roster";
      check(`shots on goal resolves NHL (${tag})`, outcome("Crosby over 3.5 shots on goal", { nba }), { sport: "NHL", betType: "PLAYER_PROP", team: [nhlTeamOf("Sidney Crosby")], desc: "Crosby over 3.5 shots on goal" });
      check(`anytime goal resolves NHL (${tag})`, outcome("Draisaitl anytime goal scorer", { nba }).sport, "NHL");
      check(`points with a unique NHL hit resolves NHL (${tag})`, outcome("Crosby over 0.5 points", { nba }), { sport: "NHL", betType: "PLAYER_PROP", team: [nhlTeamOf("Sidney Crosby")], desc: "Crosby over 0.5 points" });
      check(`an N+ assists line stores the Over form (${tag})`, outcome("Draisaitl 2+ assists", { nba }).desc, "Draisaitl Over 1.5 assists");
    }
    // A team-prefixed or NHL-coded line never reaches the roster pass.
    const coded = parseCatalog("Cap\nNHL Connor McDavid over 1.5 points", []).picks[0];
    check('"NHL Connor McDavid over 1.5 points" is still a direct NHL pick', { sport: coded?.sportName, betType: coded?.betType }, { sport: "NHL", betType: "PLAYER_PROP" });
    const prefixed = parseCatalog("Cap\nOilers McDavid over 1.5 points", []).picks[0];
    check('"Oilers McDavid over 1.5 points" is still a direct NHL pick', { sport: prefixed?.sportName, betType: prefixed?.betType, teams: prefixed?.teamNicknames }, { sport: "NHL", betType: "PLAYER_PROP", teams: ["oilers"] });
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
