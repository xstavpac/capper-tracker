// Proof for capper aliases at import and at grading - run with:
//   npx tsx src/lib/player-aliases-acceptance-test.ts
// No network, no database. Rosters are the 2026-10-13 NBA / NHL fixtures plus a small NFL roster built
// here (CMC's team has no fixture; he was also checked against ESPN's live 49ers roster when this was written).
//
//   PART A - NBA aliases: team, and the stored description takes the roster name.
//   PART B - "PG" is a position: rejected / prompted, never Paul George. "PG13" reaches the lookup.
//   PART C - league scope: an NBA alias never fires for NHL / NFL lines, an NFL alias never for NBA.
//   PART D - NFL "CMC": roster-checked, shared surname still asks, off the roster it is a miss.
//   PART E - end to end: "SGA over 30.5 points" is stored and GRADED as Shai Gilgeous-Alexander.
import fs from "node:fs";
import path from "node:path";
import { parseCatalog, parseSupportedNbaProp, explainDroppedNbaProp } from "./parse-catalog";
import { recoverUnresolvedLines } from "./recover-unresolved-lines";
import { describeUnresolvedLines } from "./bulk-import-summary";
import { parseNbaProp } from "./nba-prop";
import { parseAnyPlayerProp } from "./bet-line";
import { NBA_PLAYER_ALIASES, nbaPlayerAliasName } from "./nba-player-aliases";
import { NFL_PLAYER_ALIASES, nflPlayerAliasName } from "./nfl-player-aliases";
import { normalizeName } from "./fuzzy-match";
import { withRosterName } from "./player-roster-fallback";
import { extractNbaBoxScore } from "../server/data/nba-boxscore";
import { gradeNbaPlayerProp, type NbaPropPick } from "../server/data/nba-prop-grading";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const fx = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(__dirname, "../server/data/__fixtures__", name), "utf8"));
const NBA = fx("nba-league-roster-2026-10-13.json") as RosterPlayer[];
const NHL = fx("nhl-league-roster-2026-10-13.json") as RosterPlayer[];
const teamOf = (name: string) => NBA.find((p) => p.playerName === name)?.team.toLowerCase();
const rp = (playerName: string, lastName: string, team: string, position: string, id: string): RosterPlayer => ({
  playerName,
  firstName: playerName.split(" ")[0],
  lastName,
  team,
  position,
  externalPlayerId: id,
});
const CMC = rp("Christian McCaffrey", "McCaffrey", "San Francisco 49ers", "RB", "3117251");
const LUKE = rp("Luke McCaffrey", "McCaffrey", "Washington Commanders", "WR", "4569618");
const NFL = [CMC, LUKE];

type Outcome = { sport?: string; betType?: string; team?: string[]; description?: string; asks?: string[]; unresolved?: string | null; dropped?: true };
// One pasted line through the real import, read the way the import screen reads it.
function importText(text: string, nbaRoster: RosterPlayer[] = NBA, nflRoster: RosterPlayer[] = NFL): Outcome {
  const parsed = parseCatalog(text, []);
  const rec = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, [], nflRoster, parsed.picks, NHL, [], [], nbaRoster, parsed.unresolvedLeagues);
  const pick = parsed.picks[0] ?? rec.recovered[0];
  if (pick?.ambiguous) return { asks: pick.ambiguous.map((o) => o.label), betType: pick.betType };
  if (pick) return { sport: pick.sportName, betType: pick.betType, team: pick.teamNicknames, description: pick.description };
  if (rec.stillUnresolved.length) return { unresolved: describeUnresolvedLines(rec.stillUnresolved, rec.reasons)[0].reason };
  return { dropped: true };
}
const importLine = (line: string, nba: RosterPlayer[] = NBA, nfl: RosterPlayer[] = NFL) => importText(`Cap\n${line}`, nba, nfl);

async function main() {
  console.log("########## PART A: NBA aliases, stored under the roster name ##########");
  {
    const cases: [string, string, string][] = [
      ["SGA over 30.5 points", "Shai Gilgeous-Alexander", "Shai Gilgeous-Alexander over 30.5 points"],
      ["KAT over 22.5 rebounds", "Karl-Anthony Towns", "Karl-Anthony Towns over 22.5 rebounds"],
      ["KD o27.5 pts", "Kevin Durant", "Kevin Durant o27.5 pts"],
      ["AD over 24.5 points", "Anthony Davis", "Anthony Davis over 24.5 points"],
      ["JJJ over 1.5 blocks", "Jaren Jackson Jr.", "Jaren Jackson Jr. over 1.5 blocks"],
      ["Wemby over 3.5 blocks", "Victor Wembanyama", "Victor Wembanyama over 3.5 blocks"],
      ["PG13 over 20.5 points", "Paul George", "Paul George over 20.5 points"],
      ["PG13 o2.5 threes", "Paul George", "Paul George o2.5 threes"],
      ["sga over 30.5 points", "Shai Gilgeous-Alexander", "Shai Gilgeous-Alexander over 30.5 points"],
    ];
    for (const [line, full, desc] of cases) {
      const got = importLine(line);
      check(`${line} -> ${full}`, [got.sport, got.betType, got.team], ["NBA", "PLAYER_PROP", [teamOf(full)]]);
      check(`${line} is stored as "${desc}"`, got.description, desc);
    }
    check("an alias is NBA evidence on a points line (NHL shares the market)", importLine("SGA over 30.5 points").sport, "NBA");
    check("KAT's combined PRA line", importLine("KAT over 38.5 PRA").description, "Karl-Anthony Towns over 38.5 PRA");
    // A capper writing the real name is unchanged.
    check("a full name is stored as typed", importLine("Shai Gilgeous-Alexander over 30.5 points").description, "Shai Gilgeous-Alexander over 30.5 points");
    // A word that merely contains the alias is not rewritten: only the whole token is.
    check("'AD' inside another word is left alone (whole-word rewrite)", withRosterName("Bad AD over 24.5 points", "AD", "Anthony Davis"), "Bad Anthony Davis over 24.5 points");
  }

  console.log("\n########## PART B: PG is a position, PG13 is Paul George ##########");
  {
    const bare = importLine("PG over 20.5 points");
    check("'PG over 20.5 points' is not Paul George", bare.team?.includes(teamOf("Paul George")!) ?? false, false);
    check("...it is rejected or asks, with a reason", bare.unresolved !== undefined || (bare.asks?.length ?? 0) > 0, true);
    check("...and PG is no alias", nbaPlayerAliasName("PG"), null);
    check("'PG13' and 'pg-13' (key ignores case/punctuation) are Paul George", [nbaPlayerAliasName("PG13"), nbaPlayerAliasName("pg-13")], ["Paul George", "Paul George"]);
    check("'PG-13 over 20.5 points' (dashed) is rejected, never a guess", importLine("PG-13 over 20.5 points").team?.includes(teamOf("Paul George")!) ?? false, false);
    check("'PG13' keeps its digits through the parser", parseNbaProp("PG13 over 20.5 points")?.playerName, "PG13");
    check("...and the line is still 20.5", parseNbaProp("PG13 over 20.5 points")?.propMarket, "POINTS");
    check("another letters+digits token loses its digits as before", parseNbaProp("XY3 over 20.5 points")?.playerName, "XY");
    check("'PG13' is a supported NBA prop subject", parseSupportedNbaProp("PG13 over 20.5 points")?.subject, "person");
    check("'PG' alone is dropped with the player-name reason", /player's name|matched to a player|roster/.test(explainDroppedNbaProp("PG over 20.5 points") ?? "roster"), true);
  }

  console.log("\n########## PART C: league scope ##########");
  {
    const nhlCode = importLine("NHL SGA over 1.5 points");
    check("'NHL SGA over 1.5 points' does not fire the NBA alias", nhlCode.team?.includes(teamOf("Shai Gilgeous-Alexander")!) ?? false, false);
    check("...it stays an NHL line, with no NBA team", [nhlCode.sport, nhlCode.description], ["NHL", "SGA over 1.5 points"]);
    const nhlHeader = importText("Cap\nNHL\nSGA over 1.5 points");
    check("an NHL sub-header does not fire it either", nhlHeader.team?.includes(teamOf("Shai Gilgeous-Alexander")!) ?? false, false);
    check("an NFL line never reads an NBA alias (KD)", importLine("KD over 80.5 rushing yards").team?.includes(teamOf("Kevin Durant")!) ?? false, false);
    const cmcAsNba = importLine("CMC over 20.5 points");
    check("an NFL alias never fires for an NBA line", cmcAsNba.team?.includes(CMC.team.toLowerCase()) ?? false, false);
    check("the two alias tables share no key", [...NFL_PLAYER_ALIASES.keys()].filter((k) => NBA_PLAYER_ALIASES.has(k)), []);
  }

  console.log("\n########## PART D: NFL CMC ##########");
  {
    const cmc = importLine("CMC over 80.5 rushing yards");
    check("CMC -> Christian McCaffrey (49ers)", [cmc.sport, cmc.team], ["NFL", [CMC.team.toLowerCase()]]);
    check("CMC is stored under the roster name", cmc.description, "Christian McCaffrey over 80.5 rushing yards");
    check("lowercase / punctuated forms are the same alias", ["cmc", "C.M.C."].map(nflPlayerAliasName), ["Christian McCaffrey", "Christian McCaffrey"]);
    check("the shared surname still asks (McCaffrey)", importLine("McCaffrey over 80.5 rushing yards").asks?.length, 2);
    const off = importLine("CMC over 80.5 rushing yards", NBA, [LUKE]);
    check("off the roster the alias is a miss, never Luke", [off.team, off.unresolved !== undefined], [undefined, true]);
    check("the alias is not another rostered player's surname", NFL.filter((p) => NFL_PLAYER_ALIASES.has(normalizeName(p.lastName))), []);
    check("CMC is an NFL player on a real roster (49ers RB, checked live)", CMC.position, "RB");
    // The risky shorthands are not in the table.
    check("AB / JJ / DK / CD / OBJ are not aliases", ["AB", "JJ", "DK", "CD", "OBJ"].map(nflPlayerAliasName), [null, null, null, null, null]);
  }

  console.log("\n########## PART E: stored and graded as Shai Gilgeous-Alexander ##########");
  {
    const fixtureBox = extractNbaBoxScore(fx("nba-boxscore-401898402-okc-atl-players.json"))!;
    const game = { homeTeam: "Atlanta Hawks", awayTeam: "Oklahoma City Thunder" };
    const sgaId = NBA.find((p) => p.playerName === "Shai Gilgeous-Alexander")!.externalPlayerId;
    // The saved OKC box score is a game he did not play in, so a SYNTHETIC row is added for him (the only
    // made-up data here): same shape as every other row, his real ESPN id.
    const withSga = (points: number) => ({
      ...fixtureBox,
      players: [
        ...fixtureBox.players,
        { espnPlayerId: sgaId, playerName: "Shai Gilgeous-Alexander", team: "Oklahoma City Thunder", didNotPlay: false, points, rebounds: 5, assists: 6, steals: 1, blocks: 0, turnovers: 2, threesMade: 1 },
      ],
    });
    const gradeIn = (box: typeof fixtureBox, p: NbaPropPick) => gradeNbaPlayerProp(p, "test", { fetchBox: async () => box, getRoster: async () => NBA });
    // The pick as the import stores it: description, then the player/market parsed from that description.
    const stored = (line: string): NbaPropPick => {
      const imported = importLine(line);
      const parsed = parseAnyPlayerProp(imported.description!, "NBA");
      return { playerName: parsed?.playerName ?? null, propMarket: (parsed?.propMarket ?? null) as NbaPropPick["propMarket"], betDetail: imported.description!, ...game };
    };
    const sga = stored("SGA over 30.5 points");
    check("stored betDetail names him", sga.betDetail, "Shai Gilgeous-Alexander over 30.5 points");
    check("stored player/market", [sga.playerName, sga.propMarket], ["Shai Gilgeous Alexander", "POINTS"]);
    check("34 points: the aliased pick is a WIN", await gradeIn(withSga(34), sga), { outcome: "WIN" });
    check("28 points: the aliased pick is a LOSS", await gradeIn(withSga(28), sga), { outcome: "LOSS" });
    const fullName: NbaPropPick = { playerName: null, propMarket: null, betDetail: "Shai Gilgeous-Alexander over 30.5 points", ...game };
    check("...exactly as the full-name pick grades (34 / 28)", [await gradeIn(withSga(34), fullName), await gradeIn(withSga(28), fullName)], [{ outcome: "WIN" }, { outcome: "LOSS" }]);
    // The real saved box score: he is rostered but not listed, so BOTH spellings take the same did-not-play path.
    check("real fixture (he did not play): aliased = full name", await gradeIn(fixtureBox, sga), await gradeIn(fixtureBox, fullName));
    // Control: the capper's raw text, as the importer stored it before this change, could not be found.
    const unrewritten = await gradeIn(withSga(34), { playerName: "SGA", propMarket: "POINTS", betDetail: "SGA over 30.5 points", ...game });
    check("control: the un-rewritten 'SGA' pick stays pending (the grader knows no aliases)", unrewritten.outcome, null);
    const kat = stored("KAT over 22.5 rebounds");
    check("KAT's stored pick names Karl-Anthony Towns", kat.betDetail, "Karl-Anthony Towns over 22.5 rebounds");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
