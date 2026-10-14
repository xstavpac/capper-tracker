// Proof for NBA player-name matching at import - run with:
//   npx tsx src/lib/nba-name-matching-acceptance-test.ts
//
// No network, no database. Rosters are the real ones nba-prop-parsing-acceptance-test.ts uses,
// captured from ESPN on 2026-10-13 (625 NBA players, 824 NHL players).
//
//   PART A - 72 representative lines, through the real import (parseCatalog, then the roster
//            pass): the 24 from the NBA-props investigation, plus accented names, capper
//            nicknames, single names and a trailing "@ / vs Opp". On main 20 of these imported
//            as the right player; every one does here.
//   PART B - accents: folded for the name-shape test and for roster matching, kept in the text.
//   PART C - the alias map: every target is on the roster, no alias takes another player's
//            surname, and a line that names the NHL never reads it.
//   PART D - the opponent: taken off the player's name, and lines that are not player props
//            ("Lakers vs Nuggets over 220.5 points") are read exactly as before.
//   PART E - no NBA-prop line is dropped without a reason on the import screen.
import fs from "node:fs";
import path from "node:path";
import { parseCatalog, parseSupportedNbaProp, explainDroppedNbaProp } from "./parse-catalog";
import { recoverUnresolvedLines } from "./recover-unresolved-lines";
import { describeUnresolvedLines } from "./bulk-import-summary";
import { parseNbaProp } from "./nba-prop";
import { NBA_PLAYER_ALIASES, nbaPlayerAliasName } from "./nba-player-aliases";
import { foldDiacritics } from "./fuzzy-match";
import { resolveNameAgainstRoster } from "./player-roster-fallback";
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
const teamOf = (name: string) => NBA.find((p) => p.playerName === name)?.team.toLowerCase();

type Outcome = { sport?: string; betType?: string; team?: string[]; asks?: string[]; unresolved?: string | null; dropped?: true };
// One pasted line through the real import, read the way the import screen reads it.
function importLine(line: string, nbaRoster: RosterPlayer[] = NBA): Outcome {
  const parsed = parseCatalog(`Cap\n${line}`, []);
  const rec = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, [], [], parsed.picks, NHL, [], [], nbaRoster, parsed.unresolvedLeagues);
  const pick = parsed.picks[0] ?? rec.recovered[0];
  if (pick?.ambiguous) return { asks: pick.ambiguous.map((o) => o.label), betType: pick.betType };
  if (pick) return { sport: pick.sportName, betType: pick.betType, team: pick.teamNicknames };
  if (rec.stillUnresolved.length) return { unresolved: describeUnresolvedLines(rec.stillUnresolved, rec.reasons)[0].reason };
  return { dropped: true };
}

async function main() {
  console.log("########## PART A: 72 representative lines ##########");
  {
    // [group, line, the roster player it is - or "TEAM:<nickname>" for a team-prefixed line, "ASK" for a prompt]
    const cases: [string, string, string][] = [
      ["orig", "Jalen Brunson Over 24.5 Points -115", "Jalen Brunson"],
      ["orig", "Jokic PRA o48.5", "Nikola Jokic"],
      ["orig", "jokic o10.5 reb", "Nikola Jokic"],
      ["orig", "Nikola Jokić over 11.5 rebounds", "Nikola Jokic"],
      ["orig", "Luka Dončić Over 8.5 Assists (-120) 2u", "Luka Doncic"],
      ["orig", "SGA o31.5 points", "Shai Gilgeous-Alexander"],
      ["orig", "Shai Gilgeous-Alexander over 30.5 pts", "Shai Gilgeous-Alexander"],
      ["orig", "Steph Curry o4.5 3PM", "Stephen Curry"],
      ["orig", "Anthony Edwards 3+ threes", "Anthony Edwards"],
      ["orig", "Wemby over 3.5 blocks", "Victor Wembanyama"],
      ["orig", "Giannis double double", "Giannis Antetokounmpo"],
      ["orig", "LeBron Over 6.5 turnovers", "LeBron James"],
      ["orig", "Jaren Jackson Jr. o1.5 blocks", "Jaren Jackson Jr."],
      ["orig", "NBA: Tatum over 8.5 rebounds", "Jayson Tatum"],
      ["orig", "Lakers LeBron over 7.5 rebounds", "TEAM:lakers"],
      ["orig", "Jalen Brunson (NYK) o24.5 pts", "Jalen Brunson"],
      ["orig", "Jalen Brunson Points O24.5", "Jalen Brunson"],
      ["orig", "Points Over 24.5 Jalen Brunson", "Jalen Brunson"],
      ["orig", "Jalen Brunson Over 24.5 Points + Rebounds", "Jalen Brunson"],
      ["orig", "Tatum O 38.5 Pts+Reb+Ast", "Jayson Tatum"],
      ["orig", "De'Aaron Fox over 5.5 assists", "De'Aaron Fox"],
      ["orig", "Jalen Brunson 25+ Pts", "Jalen Brunson"],
      ["orig", "Jalen Brunson Over 24.5 Pts @ Celtics", "Jalen Brunson"],
      ["orig", "Josh Giddey Triple Double +900", "Josh Giddey"],
      ["accent", "Nikola Jokić o10.5 reb", "Nikola Jokic"],
      ["accent", "jokić o10.5 reb", "Nikola Jokic"],
      ["accent", "Luka Dončić 30+ points", "Luka Doncic"],
      ["accent", "Bogdan Bogdanović over 2.5 threes", "Bogdan Bogdanovic"],
      ["accent", "Kristaps Porziņģis o1.5 blocks", "Kristaps Porzingis"],
      ["accent", "Alperen Şengün PRA o35.5", "Alperen Sengun"],
      ["accent", "Dennis Schröder over 5.5 assists", "Dennis Schroder"],
      ["accent", "Nikola Vučević double-double", "Nikola Vucevic"],
      ["accent", "Jusuf Nurkić u9.5 rebounds", "Jusuf Nurkic"],
      ["accent", "Dončić o8.5 ast", "Luka Doncic"],
      ["nick", "KAT o11.5 rebounds", "Karl-Anthony Towns"],
      ["nick", "Ant over 26.5 points", "Anthony Edwards"],
      ["nick", "Steph over 4.5 threes", "Stephen Curry"],
      ["nick", "Luka PRA o45.5", "Luka Doncic"],
      ["nick", "Embiid o29.5 pts", "Joel Embiid"],
      ["nick", "Joker over 9.5 assists", "Nikola Jokic"],
      ["nick", "Dame o2.5 threes", "Damian Lillard"],
      ["nick", "JJJ o1.5 blocks", "Jaren Jackson Jr."],
      ["nick", "KD o26.5 pts", "Kevin Durant"],
      ["nick", "Spida over 24.5 points", "Donovan Mitchell"],
      ["nick", "AD o11.5 reb", "Anthony Davis"],
      ["nick", "PG13 o2.5 threes", "Paul George"],
      ["nick", "SGA 30+ points", "Shai Gilgeous-Alexander"],
      ["nick", "Wemby double-double", "Victor Wembanyama"],
      ["nick", "Greek Freak o11.5 reb", "Giannis Antetokounmpo"],
      ["nick", "Hali o9.5 ast", "Tyrese Haliburton"],
      ["single", "Giannis o11.5 reb", "Giannis Antetokounmpo"],
      ["single", "LeBron Over 24.5 Points", "LeBron James"],
      ["single", "LeBron o7.5 assists", "LeBron James"],
      ["single", "Luka o8.5 ast", "Luka Doncic"],
      ["single", "Zion over 22.5 points", "Zion Williamson"],
      ["single", "Ja over 6.5 assists", "Ja Morant"],
      ["single", "Trae o10.5 ast", "Trae Young"],
      ["single", "Chet over 2.5 blocks", "Chet Holmgren"],
      ["single", "Bam over 9.5 rebounds", "Bam Adebayo"],
      ["single", "Cade o9.5 assists", "Cade Cunningham"],
      ["single", "Paolo over 24.5 pts", "Paolo Banchero"],
      ["single", "Kawhi o5.5 reb", "Kawhi Leonard"],
      ["single", "Brunson o24.5 pts", "Jalen Brunson"],
      ["single", "Williams over 10.5 points", "ASK"],
      ["opp", "Tatum o8.5 reb vs Knicks", "Jayson Tatum"],
      ["opp", "Jokic PRA o48.5 v. Lakers", "Nikola Jokic"],
      ["opp", "Luka Dončić Over 30.5 Points @ LAC", "Luka Doncic"],
      ["opp", "Steph Curry o4.5 3PM vs. Lakers", "Stephen Curry"],
      ["opp", "SGA 30+ points @ Spurs", "Shai Gilgeous-Alexander"],
      ["opp", "Brunson @ BOS o24.5 pts", "Jalen Brunson"],
      ["opp", "Wemby over 3.5 blocks at Mavericks", "Victor Wembanyama"],
      ["opp", "Jalen Brunson over 24.5 points vs Boston Celtics", "Jalen Brunson"],
    ];
    const byGroup = new Map<string, [number, number]>();
    for (const [group, line, want] of cases) {
      const got = importLine(line);
      let ok: boolean;
      if (want === "ASK") ok = (got.asks?.length ?? 0) > 1;
      else if (want.startsWith("TEAM:")) ok = got.sport === "NBA" && got.betType === "PLAYER_PROP" && (got.team ?? []).includes(want.slice(5));
      else ok = got.sport === "NBA" && got.betType === "PLAYER_PROP" && JSON.stringify(got.team) === JSON.stringify([teamOf(want)]);
      check(`[${group}] ${line} -> ${want}`, ok ? "ok" : got, "ok");
      const g = byGroup.get(group) ?? [0, 0];
      byGroup.set(group, [g[0] + (ok ? 1 : 0), g[1] + 1]);
    }
    console.log("   " + [...byGroup].map(([g, [a, b]]) => `${g} ${a}/${b}`).join(", "));
    // "Williams" is 14 NBA players (and an NHL one - points is hockey's market too): asked, never guessed.
    check("'Williams' asks among the Williamses only, each tagged with its league", importLine("Williams over 10.5 points").asks?.every((l) => /Williams(?: III)? — .* \((?:NBA|NHL)\)$/.test(l)), true);
  }

  console.log("\n########## PART B: accents ##########");
  {
    check("foldDiacritics", ["Jokić", "Dončić", "Porziņģis", "Şengün", "Schröder", "Vučević"].map(foldDiacritics), ["Jokic", "Doncic", "Porzingis", "Sengun", "Schroder", "Vucevic"]);
    check("an accented capitalized name is a person (was not: the shape test is ASCII)", parseSupportedNbaProp("Nikola Jokić over 11.5 rebounds")?.subject, "person");
    check("the parsed name keeps its accents (the text is not rewritten)", parseNbaProp("Nikola Jokić over 11.5 rebounds")?.playerName, "Nikola Jokić");
    const r = resolveNameAgainstRoster("Nikola Jokić", NBA, undefined, "NBA");
    check("roster matching folds both sides: exact tier, not fuzzy", r.status === "resolved" ? [r.playerName, r.via] : r, ["Nikola Jokic", "exact"]);
    const s = resolveNameAgainstRoster("Dončić", NBA, undefined, "NBA");
    check("...and the surname tier", s.status === "resolved" ? [s.playerName, s.via] : s, ["Luka Doncic", "surname"]);
    check("an unaccented name still matches as before", (resolveNameAgainstRoster("Nikola Jokic", NBA, undefined, "NBA") as { via?: string }).via, "exact");
  }

  console.log("\n########## PART C: the alias map ##########");
  {
    const rosterNames = new Set(NBA.map((p) => p.playerName));
    const targets = [...new Set(NBA_PLAYER_ALIASES.values())];
    check("every alias names a player on the 2026-10-13 roster", targets.filter((t) => !rosterNames.has(t)), []);
    // An alias must never take a surname the surname tier would resolve to someone else.
    const surnameClash = [...NBA_PLAYER_ALIASES].filter(([key, full]) => NBA.some((p) => p.lastName.toLowerCase().replace(/[^a-z0-9]/g, "") === key && p.playerName !== full));
    check("no alias is another player's surname", surnameClash, []);
    check("keys ignore case, spacing and punctuation", ["sga", "S.G.A.", "Ant-Man", "antman", "greek freak", "PG-13"].map(nbaPlayerAliasName), [
      "Shai Gilgeous-Alexander",
      "Shai Gilgeous-Alexander",
      "Anthony Edwards",
      "Anthony Edwards",
      "Giannis Antetokounmpo",
      "Paul George",
    ]);
    check("a name that is not an alias", nbaPlayerAliasName("Brunson"), null);
    // The alias is read before the surname tier: "Luka" is two rostered players' FIRST name, never a surname.
    check("'Luka' is Doncic, not a prompt", importLine("Luka o8.5 ast").team, [teamOf("Luka Doncic")]);
    // A line that names the NHL never reads the NBA alias map.
    check("'NHL: Ant over 0.5 points' is not Anthony Edwards", importLine("NHL: Ant over 0.5 points").team?.includes(teamOf("Anthony Edwards")!) ?? false, false);
    // An alias whose player has left the roster falls back to what was typed.
    const noLuka = NBA.filter((p) => p.playerName !== "Luka Doncic");
    check("an alias off the roster: matched as typed ('Luka' is nobody's surname)", importLine("Luka o8.5 ast", noLuka), { unresolved: 'couldn\'t find "Luka" on an NBA or NHL roster' });
  }

  console.log("\n########## PART D: the opponent ##########");
  {
    check("'@ Celtics' comes off the name", parseNbaProp("Jalen Brunson Over 24.5 Pts @ Celtics"), { playerName: "Jalen Brunson", propMarket: "POINTS", opponent: "Celtics" });
    check("'@BOS' with no space", parseNbaProp("Brunson @BOS o24.5 pts")?.opponent, "BOS");
    check("'v. Lakers'", parseNbaProp("Jokic PRA o48.5 v. Lakers")?.opponent, "Lakers");
    check("'versus Boston Celtics'", parseNbaProp("Jalen Brunson over 24.5 points versus Boston Celtics")?.opponent, "Boston Celtics");
    check("no opponent: no key at all (unchanged shape)", parseNbaProp("Jalen Brunson over 24.5 points"), { playerName: "Jalen Brunson", propMarket: "POINTS" });
    // Was imported as an NBA game TOTAL on the Lakers on main.
    check("'Jokic PRA o48.5 v. Lakers' is a Jokic prop, not a Lakers total", importLine("Jokic PRA o48.5 v. Lakers"), { sport: "NBA", betType: "PLAYER_PROP", team: [teamOf("Nikola Jokic")!] });
    // Lines that are not player props read exactly as on main.
    check("game total 'Lakers vs Nuggets over 220.5 points' unchanged", importLine("Lakers vs Nuggets over 220.5 points"), { sport: "NBA", betType: "TOTAL", team: ["nuggets", "lakers"] });
    check("game total 'Celtics @ Knicks o215.5 pts' unchanged", importLine("Celtics @ Knicks o215.5 pts"), { sport: "NBA", betType: "TOTAL", team: ["celtics", "knicks"] });
    check("game total 'Kings vs Lakers over 230.5 points' unchanged", importLine("Kings vs Lakers over 230.5 points"), { sport: "NBA", betType: "TOTAL", team: ["lakers"] });
    check("team total unchanged", importLine("Lakers Team Total over 110.5 points"), { sport: "NBA", betType: "TEAM_TOTAL", team: ["lakers"] });
    check("'Boston vs New York over 220.5 points' still asks which Boston", (importLine("Boston vs New York over 220.5 points").asks ?? []).length, 3);
    check("NHL 'Connor McDavid over 1.5 points' unchanged", importLine("Connor McDavid over 1.5 points").sport, "NHL");
    // A team-prefixed player line with an opponent is a player prop on that game (main: "Game stat totals aren't supported yet").
    check("'Lakers LeBron vs Nuggets o7.5 reb' -> player prop on that game", importLine("Lakers LeBron vs Nuggets o7.5 reb"), { sport: "NBA", betType: "PLAYER_PROP", team: ["nuggets", "lakers"] });
    check("an opponent that isn't a team: not a player prop line", parseSupportedNbaProp("Brunson over 24.5 points vs everyone"), null);
  }

  console.log("\n########## PART E: no silent drops ##########");
  {
    const reason = (line: string, roster: RosterPlayer[] = NBA) => importLine(line, roster).unresolved;
    check(
      "an opponent that isn't a team says so",
      reason("Brunson over 24.5 points vs everyone"),
      'this reads as an NBA player prop on "Brunson", but "everyone" after the @ / vs isn\'t a team this app knows - use the team\'s name or code ("@ Celtics", "vs BOS")'
    );
    check(
      "a subject that isn't name-shaped says so (was: no reason)",
      reason("J. Brunson #11 over 24.5 points"),
      'this reads as an NBA player prop, but "J. Brunson #" doesn\'t look like a player\'s name - write the player\'s name, then the line ("Jalen Brunson over 24.5 points")'
    );
    check("a lowercase name no roster knows keeps the roster's verdict (was: no reason)", reason("xyzzy o10.5 reb"), 'couldn\'t find "xyzzy" on an NBA roster');
    check("no NBA roster, lowercase name (was: no reason)", reason("jokic o10.5 reb", []), "NBA player props need the NBA roster, which isn't available right now");
    check("no NBA roster, accented name (was: no reason)", reason("Nikola Jokić over 11.5 rebounds", []), "NBA player props need the NBA roster, which isn't available right now");
    check("no NBA roster, opponent tail (was: 'Player prop not supported yet')", reason("Jokic double-double vs Lakers", []), "NBA player props need the NBA roster, which isn't available right now");
    // Sweep: every line above that reads as an NBA prop, with and without a roster - none ends
    // unresolved without a reason, and none is dropped outright.
    const sweep = [
      "Brunson over 24.5 points vs everyone",
      "J. Brunson #11 over 24.5 points",
      "xyzzy o10.5 reb",
      "Zed Nobody over 10.5 points",
      "Nikola Jokić over 11.5 rebounds",
      "jokić o10.5 reb",
      "Nikola Vučević double-double",
      "Brunson @ BOS o24.5 pts",
      "Wemby over 3.5 blocks at Mavericks",
      "Paul o2.5 3pm",
      "LeBron Over 6.5 turnovers",
      "Josh Giddey Triple Double +900",
    ];
    for (const roster of [NBA, []]) {
      const silent = sweep.filter((l) => {
        const o = importLine(l, roster);
        return o.dropped || (o.unresolved !== undefined && !o.unresolved);
      });
      check(`no silent drops (${roster.length ? "with" : "without"} a roster)`, silent, []);
    }
    // Not an NBA player prop: no NBA reason is invented for it.
    check("a team line gets no NBA-prop reason", explainDroppedNbaProp("Lakers Team Total over 110.5 points"), null);
    check("another league's code gets no NBA-prop reason", explainDroppedNbaProp("NHL McDavid over 1.5 points"), null);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
