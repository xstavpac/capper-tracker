// Proof for the NBA catalog aliases, team codes, context signals and prop
// shorthand detection - run with:
//   npx tsx src/lib/nba-aliases-acceptance-test.ts
//
// No test framework in this repo (see parse-catalog-acceptance-test.ts's
// header). console.logs PASS/FAIL, exits non-zero on any failure.
//
//   PART A - every new alias / 3-letter code resolves to its NBA team, and its
//            translation is a suffix of the real live-schedule name.
//   PART B - every excluded code stays out: it resolves to nothing, exactly as
//            before, and is not in the translation table.
//   PART C - "philly" is a four-team city key; the collisions the new entries
//            would have opened ("Philly Eagles", "Red Wolves") are closed.
//   PART D - NBA pick-context signals, and "points" not out-voting football.
//   PART E - NBA prop shorthand is detected (still rejected, never imported,
//            never read as a tennis player) without swallowing a start time
//            or "STL" on a team's own total.
//   PART F - "LA Clippers" (ESPN) vs "los angeles clippers" (the city-key
//            candidate): the game is found and the pick keeps its side.
//   PART G - a preseason exhibition opponent ("London Lions").
import {
  parseCatalog,
  inferSportFromPickContext,
  matchingSportsForPickContext,
  TEAM_NICKNAME_CANONICAL,
  ambiguousOptionsFor,
  resolveAmbiguousPick,
  teamGroupAliases,
  detectUnsupportedPropLine,
  parseSupportedNbaProp,
} from "./parse-catalog";
import { runAmbiguousHierarchy, type ScheduleChecker, type ScheduleCheckQuery } from "./ambiguous-hierarchy";
import { UNSUPPORTED_PROP_REASONS } from "./unsupported-prop-vocab";
import { sideForNickname, teamNameEndsWith } from "./team-name-match";
import { resolveLineAgainstLiveTeams } from "./live-team-fallback";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const parse = (line: string) => parseCatalog(`Cap\n${line}`, []);
const first = (line: string) => parse(line).picks[0];

function fakeSchedule(playing: string[]): ScheduleChecker {
  const set = new Set(playing);
  return async (queries: ScheduleCheckQuery[]) => {
    const out: Record<string, boolean> = {};
    for (const q of queries) out[q.nickname + "|" + q.sport] = set.has(q.nickname + "|" + q.sport);
    return out;
  };
}

async function main() {
  console.log("########## PART A: new aliases and 3-letter codes ##########");
  {
    // [alias, canonical it translates to, real live-schedule full name (ESPN)]
    const aliases: [string, string, string][] = [
      ["wolves", "timberwolves", "Minnesota Timberwolves"],
      ["t-wolves", "timberwolves", "Minnesota Timberwolves"],
      ["twolves", "timberwolves", "Minnesota Timberwolves"],
      ["clips", "clippers", "LA Clippers"],
      ["okc", "thunder", "Oklahoma City Thunder"],
      ["bkn", "nets", "Brooklyn Nets"],
      ["cha", "hornets", "Charlotte Hornets"],
      ["gsw", "warriors", "Golden State Warriors"],
      ["lal", "lakers", "Los Angeles Lakers"],
      ["nyk", "knicks", "New York Knicks"],
      ["nop", "pelicans", "New Orleans Pelicans"],
      ["orl", "magic", "Orlando Magic"],
      ["sas", "spurs", "San Antonio Spurs"],
    ];
    for (const [alias, canonical, fullName] of aliases) {
      const upper = first(`${alias.toUpperCase()} -3.5`);
      check(`'${alias.toUpperCase()} -3.5' -> NBA, nickname '${alias}'`, { sport: upper?.sportName, teams: upper?.teamNicknames, type: upper?.betType }, { sport: "NBA", teams: [alias], type: "SPREAD" });
      check(`'${alias} ml' (lowercase) -> NBA`, first(`${alias} ml`)?.sportName, "NBA");
      check(`'${alias}' translates to '${canonical}'`, TEAM_NICKNAME_CANONICAL[alias], canonical);
      check(`'${canonical}' is a suffix of "${fullName}"`, fullName.toLowerCase().endsWith(canonical), true);
      check(`'${alias}' is a grouping alias of ${fullName}`, teamGroupAliases(fullName, "NBA").includes(alias), true);
    }

    const matchup = first("LAL @ GSW over 225.5");
    check("'LAL @ GSW over 225.5' -> NBA total naming both teams", { sport: matchup?.sportName, type: matchup?.betType, teams: [...(matchup?.teamNicknames ?? [])].sort() }, { sport: "NBA", type: "TOTAL", teams: ["gsw", "lal"] });

    // A code next to its own mascot is one team, not a matchup: bulk-picks.ts
    // translates through TEAM_NICKNAME_CANONICAL and dedupes before the lookup.
    const okcThunder = first("OKC Thunder -7.5");
    check("'OKC Thunder -7.5' -> NBA", okcThunder?.sportName, "NBA");
    check("'OKC Thunder' translates to one team", [...new Set((okcThunder?.teamNicknames ?? []).map((n) => TEAM_NICKNAME_CANONICAL[n] ?? n))], ["thunder"]);

    // Whole-token only.
    check("'Orlov ML' does not resolve as 'orl'", first("Orlov ML")?.sportName === "NBA", false);
    check("'Sasha ML' does not resolve as 'sas'", first("Sasha ML")?.sportName === "NBA", false);
    check("'Clipse -2' does not resolve as 'clips'", first("Clipse -2")?.sportName === "NBA", false);
    check("'Timberwolves -3' still resolves by its full mascot", first("Timberwolves -3")?.teamNicknames, ["timberwolves"]);
  }

  console.log("\n########## PART B: excluded codes ##########");
  {
    // Shared with another tracked team (or an ordinary word): not an NBA
    // alias, not in the translation table, and the line is left unresolved -
    // the behavior these codes had before this change.
    const excluded = [
      "atl", "bos", "chi", "cle", "dal", "den", "det", "hou", "ind", "mia", "mil", "min", "phi", "tor", "wsh",
      "lac", "mem", "phx", "por", "sac", "uta", "was", "gs", "no", "ny", "sa",
    ];
    for (const code of excluded) {
      const res = parse(`${code.toUpperCase()} -3.5`);
      check(`'${code.toUpperCase()} -3.5' is not read as an NBA team`, { pick: res.picks[0]?.sportName ?? null, unresolved: res.unresolved }, { pick: null, unresolved: [`${code.toUpperCase()} -3.5`] });
      check(`'${code}' is not in the translation table`, TEAM_NICKNAME_CANONICAL[code], undefined);
    }
    // "utah" is the existing city key (Jazz / Mammoth / Utes), still a prompt.
    check("'Utah -3.5' is still the ambiguous city key", first("Utah -3.5")?.ambiguousKey, "utah");
    // "wiz" stays KBO's KT Wiz, never the Wizards.
    check("'Wiz -3' is still KBO, not the Wizards", first("Wiz -3")?.sportName, "KBO");
    check("'wiz' has no NBA translation", TEAM_NICKNAME_CANONICAL["wiz"], undefined);
    // Ordinary words that are also codes do not turn prose into a pick.
    check("'It was +8 last week' is not a Wizards pick", parse("It was +8 last week").picks.some((p) => p.sportName === "NBA"), false);
  }

  console.log("\n########## PART C: philly, and the collisions the new entries would open ##########");
  {
    const philly = first("Philly -3");
    check("'Philly -3' is ambiguous under the 'philly' key", { key: philly?.ambiguousKey, sport: philly?.sportName }, { key: "philly", sport: "" });
    check("'philly' offers the same four teams as 'philadelphia'", ambiguousOptionsFor("philly"), ambiguousOptionsFor("philadelphia"));
    check("'philly' options", ambiguousOptionsFor("philly").map((o) => o.sport), ["NFL", "MLB", "NBA", "NHL"]);

    // Only the 76ers have a game: schedule-first resolves it to the NBA.
    const OCT = new Date("2026-10-22T16:00:00Z");
    const viaSchedule = await runAmbiguousHierarchy([philly!], {}, {
      runScheduleCheck: fakeSchedule(["philadelphia 76ers|NBA"]),
      runWideScheduleCheck: fakeSchedule([]),
      now: OCT,
    });
    check("'Philly -3', only the 76ers playing -> NBA via schedule", { sport: viaSchedule.picks[0].sportName, teams: viaSchedule.picks[0].teamNicknames, method: viaSchedule.logs[0]?.method }, { sport: "NBA", teams: ["philadelphia 76ers"], method: "schedule" });
    // Eagles and 76ers both playing: nothing to tell them apart, so it prompts.
    const both = await runAmbiguousHierarchy([first("Philly ML")], {}, {
      runScheduleCheck: fakeSchedule(["philadelphia 76ers|NBA", "philadelphia eagles|NFL"]),
      runWideScheduleCheck: fakeSchedule([]),
      now: OCT,
    });
    check("'Philly ML', Eagles and 76ers both playing -> prompts", { sport: both.picks[0].sportName, key: both.stillAmbiguous[0]?.key }, { sport: "", key: "philly" });

    check("'Philly Sixers -3' -> NBA directly", { sport: first("Philly Sixers -3")?.sportName, teams: first("Philly Sixers -3")?.teamNicknames }, { sport: "NBA", teams: ["sixers"] });
    check("'Philly Flyers ML' -> NHL directly", first("Philly Flyers ML")?.sportName, "NHL");
    // Two ambiguous keys on one line ("philly" + "eagles") would read as a
    // two-team matchup; named whole it is the one NFL team.
    const phillyEagles = first("Philly Eagles -3");
    check("'Philly Eagles -3' -> NFL, one team", { sport: phillyEagles?.sportName, teams: phillyEagles?.teamNicknames }, { sport: "NFL", teams: ["philly eagles"] });
    check("'philly eagles' translates to the live-schedule name", TEAM_NICKNAME_CANONICAL["philly eagles"], "philadelphia eagles");
    check("bare 'Eagles -3' is still the NFL/KBO prompt", first("Eagles -3")?.ambiguousKey, "eagles");
    check("'philly' is a city key, not a grouping alias", teamGroupAliases("Philadelphia 76ers", "NBA").includes("philly"), false);

    // "wolves" must not claim Arkansas State's Red Wolves.
    const redWolves = first("Red Wolves -3");
    check("'Red Wolves -3' -> NCAAF (Arkansas State), not the Timberwolves", { sport: redWolves?.sportName, teams: redWolves?.teamNicknames }, { sport: "NCAAF", teams: ["red wolves"] });
    check("'red wolves' translates to the live-schedule name", TEAM_NICKNAME_CANONICAL["red wolves"], "arkansas state red wolves");
    const full = first("Arkansas State Red Wolves -3");
    check("'Arkansas State Red Wolves -3' -> NCAAF, one team after translation", { sport: full?.sportName, teams: [...new Set((full?.teamNicknames ?? []).map((n) => TEAM_NICKNAME_CANONICAL[n] ?? n))] }, { sport: "NCAAF", teams: ["arkansas state red wolves"] });
    check("'Arkansas State -3' unchanged", first("Arkansas State -3")?.teamNicknames, ["arkansas state"]);
    // KNOWN EXPOSURE, pinned on purpose: like every bare mascot in the team
    // lists ("Berlin Thunder ML" has always read as the NBA's Thunder), an
    // untracked team that ends in "Wolves" now reads as the Timberwolves.
    check("KNOWN EXPOSURE: 'Berlin Wolves ML' reads as the Timberwolves", first("Berlin Wolves ML")?.sportName, "NBA");
    check("...the same standing 'Berlin Thunder ML' already had", first("Berlin Thunder ML")?.sportName, "NBA");
    // An explicit league code still wins over the alias.
    check("'EPL Wolves ML' stays EPL", first("EPL Wolves ML")?.sportName, "EPL");
  }

  console.log("\n########## PART D: NBA pick-context signals ##########");
  {
    // Candidates of a bare "Boston": Red Sox, Celtics, Bruins.
    const BOSTON = ["MLB", "NBA", "NHL"];
    for (const text of [
      "Boston o24.5 pts",
      "Boston over 215.5 points",
      "Boston o38.5 PRA",
      "Boston o30.5 P+R",
      "Boston o30.5 p+a",
      "Boston o14.5 R+A",
      "Boston o2.5 3pm",
      "Boston 2+ 3s",
      "Boston over 2.5 threes",
      "Boston o1.5 stl",
      "Boston 2+ steals",
      "Boston o0.5 blk",
      "Boston 2+ blocks",
      "Boston double-double",
      "Boston double double",
      "Boston DD",
      "Boston o9.5 rebounds",
      "Boston 1st quarter -1.5",
    ]) {
      check(`'${text}' -> NBA among MLB/NBA/NHL`, inferSportFromPickContext(text, BOSTON), "NBA");
    }
    check("lowercase 'dd' is not a signal", inferSportFromPickContext("Boston dd", BOSTON), null);
    check("'Boston ML' has no signal", inferSportFromPickContext("Boston ML", BOSTON), null);
    check("'Boston puck line' is still NHL", inferSportFromPickContext("Boston puck line -1.5", BOSTON), "NHL");

    // "points" says nothing when a football or other basketball league is a candidate.
    check("'New York over 44.5 points' (NFL/NBA/MLB): points does not pick the NBA", matchingSportsForPickContext("New York over 44.5 points", ["NFL", "NBA", "MLB"]), []);
    check("'Indiana over 160.5 points' (NBA/WNBA/NCAAF): points does not pick the NBA", matchingSportsForPickContext("Indiana over 160.5 pts", ["NBA", "WNBA", "NCAAF"]), []);
    check("'Houston over 51.5 points' (NFL/MLB/NBA/NCAAF): no signal", inferSportFromPickContext("Houston over 51.5 points", ["NFL", "MLB", "NBA", "NCAAF"]), null);
    // End to end: a football total on a city key is not handed to the NBA.
    const ny = await runAmbiguousHierarchy([first("New York over 44.5 points")], {}, {
      runScheduleCheck: fakeSchedule([]),
      runWideScheduleCheck: fakeSchedule([]),
      now: new Date("2026-11-10T16:00:00Z"),
    });
    check("'New York over 44.5 points' in November is never resolved to the NBA", ny.picks[0].sportName === "NBA", false);
  }

  console.log("\n########## PART E: NBA prop shorthand is detected, and stays rejected ##########");
  {
    for (const line of [
      "Paul o2.5 3pm",
      "Paul George over 2.5 3s",
      "Curry 4+ 3pm",
      "LeBron James 2+ stl",
      "Caruso o1.5 stl",
      "Wembanyama o3.5 blk",
      "Jokic o38.5 p+r",
      "Haliburton u30.5 P+A",
      "Sabonis o19.5 r+a",
      "Jokic double-double",
      "Sabonis to record a double double",
    ]) {
      // Since NBA props import (nba-prop.ts) the line is a recognized player prop, no longer flagged
      // "unsupported"; it is parked for the roster pass exactly as it was kept unresolved before.
      check(`'${line}' is read as a player prop naming a person`, [detectUnsupportedPropLine(line), parseSupportedNbaProp(line)?.subject], [null, "person"]);
      const res = parse(line);
      check(`'${line}' is not imported, and is kept as unresolved`, { picks: res.picks.length, unresolved: res.unresolved }, { picks: 0, unresolved: [line] });
    }
    check("an explicit NBA code is read the same way", [detectUnsupportedPropLine("NBA Jokic o38.5 p+r"), parseSupportedNbaProp("NBA Jokic o38.5 p+r")?.prop.propMarket], [null, "POINTS_REBOUNDS"]);
    // A league this app has no props for keeps its reason.
    check("a WNBA code keeps the WNBA reason", detectUnsupportedPropLine("WNBA A'ja Wilson o9.5 reb")?.reason, UNSUPPORTED_PROP_REASONS.WNBA);

    // The tennis exclusion: "Paul" is a KNOWN_TENNIS_PLAYERS surname, and
    // "Paul o2.5 3pm" used to import as an ATP total.
    check("'Paul o2.5 3pm' is not an ATP pick", parse("Paul o2.5 3pm").picks.some((p) => p.sportName === "ATP"), false);
    check("'Paul ML' is still an ATP pick", first("Paul ML")?.sportName, "ATP");

    // A capper header is not a pick; a team is not a player.
    const header = parseCatalog(`Double Double Picks\nLakers -3`, []);
    check("'Double Double Picks' is still a capper header", { capper: header.picks[0]?.capperName, unresolved: header.unresolved }, { capper: "Double Double Picks", unresolved: [] });
    check("'Lakers double-double' is not flagged as a player prop", detectUnsupportedPropLine("Lakers double-double"), null);

    // "3pm" after a team's number is a start time; "STL" is St. Louis.
    const time = first("Yankees o8.5 3pm");
    check("'Yankees o8.5 3pm' is still an MLB total", { sport: time?.sportName, type: time?.betType }, { sport: "MLB", type: "TOTAL" });
    const lakersTime = first("Lakers o225.5 3pm");
    check("'Lakers o225.5 3pm' is still an NBA total", { sport: lakersTime?.sportName, type: lakersTime?.betType }, { sport: "NBA", type: "TOTAL" });
    const stl = first("Cubs u7.5 STL");
    check("'Cubs u7.5 STL' is still an MLB total", { sport: stl?.sportName, type: stl?.betType }, { sport: "MLB", type: "TOTAL" });
    check("'u8.5 STL' with no subject is not flagged", detectUnsupportedPropLine("u8.5 STL"), null);
    // A team's own stat total keeps its existing reason.
    check("'Lakers over 7.5 blk' is a team stat total", detectUnsupportedPropLine("Lakers over 7.5 blk")?.reason, UNSUPPORTED_PROP_REASONS.TEAM_STAT);
    // Ordinary game lines are untouched.
    check("'Lakers over 220.5 points' is not flagged", detectUnsupportedPropLine("Lakers over 220.5 points"), null);
    check("'Lakers -3.5' is not flagged", detectUnsupportedPropLine("Lakers -3.5"), null);
  }

  console.log("\n########## PART F: 'LA Clippers' vs 'los angeles clippers' ##########");
  {
    const NBA = "basketball_nba";
    // ESPN's score feed says "LA Clippers"; the Odds API says "Los Angeles Clippers".
    const espnGame = { homeTeam: "LA Clippers", awayTeam: "Sacramento Kings" };
    const oddsGame = { homeTeam: "Sacramento Kings", awayTeam: "Los Angeles Clippers" };

    // The city-key path: "Los Angeles -4.5" -> the Clippers candidate.
    const la = first("Los Angeles -4.5");
    check("'Los Angeles -4.5' is ambiguous under 'los angeles'", la?.ambiguousKey, "los angeles");
    const clippers = ambiguousOptionsFor("los angeles").find((o) => o.label.includes("Clippers"))!;
    const resolved = resolveAmbiguousPick(la!, clippers);
    check("choosing the Clippers gives the nickname 'los angeles clippers'", { sport: resolved.sportName, teams: resolved.teamNicknames }, { sport: "NBA", teams: ["los angeles clippers"] });
    const nickname = TEAM_NICKNAME_CANONICAL[resolved.teamNicknames[0]] ?? resolved.teamNicknames[0];

    // Finding the game (resolveGameForNickname's test) works against both feeds.
    check("the nickname finds ESPN's 'LA Clippers' game", teamNameEndsWith(espnGame.homeTeam, nickname, NBA), true);
    check("the nickname finds the Odds API's 'Los Angeles Clippers' game", teamNameEndsWith(oddsGame.awayTeam, nickname, NBA), true);
    check("the nickname does not find the Lakers", teamNameEndsWith("Los Angeles Lakers", nickname, NBA), false);

    // The pick's side. The old bare endsWith said "neither" on ESPN's spelling.
    check("old bare endsWith: 'la clippers' does not end with the nickname", espnGame.homeTeam.toLowerCase().endsWith(nickname), false);
    check("ESPN-spelled game: the pick is on the HOME side", sideForNickname(espnGame, nickname, NBA), "HOME");
    check("Odds-API-spelled game: the pick is on the AWAY side", sideForNickname(oddsGame, nickname, NBA), "AWAY");
    // Bare "clippers" / "clips" (after translation) were never affected.
    check("'clippers' on ESPN's spelling: HOME", sideForNickname(espnGame, "clippers", NBA), "HOME");
    check("'clips' translates and lands on the same side", sideForNickname(espnGame, TEAM_NICKNAME_CANONICAL["clips"], NBA), "HOME");
    // Lakers @ Clippers: each nickname names exactly one side.
    const derby = { homeTeam: "LA Clippers", awayTeam: "Los Angeles Lakers" };
    check("Lakers @ Clippers: 'los angeles clippers' is HOME", sideForNickname(derby, "los angeles clippers", NBA), "HOME");
    check("Lakers @ Clippers: 'los angeles lakers' is AWAY", sideForNickname(derby, "los angeles lakers", NBA), "AWAY");
    // Unchanged for every name the two feeds already agree on.
    check("'cubs' on Cubs @ Cardinals: AWAY", sideForNickname({ homeTeam: "St. Louis Cardinals", awayTeam: "Chicago Cubs" }, "cubs", "baseball_mlb"), "AWAY");
    check("a nickname naming neither team: null", sideForNickname(espnGame, "lakers", NBA), null);
    check("a nickname both teams end with: null", sideForNickname({ homeTeam: "New York Giants", awayTeam: "San Francisco Giants" }, "giants"), null);
  }

  console.log("\n########## PART G: a preseason exhibition opponent ##########");
  {
    // Portland hosted the London Lions on 2026-10-12 (ESPN event 401914130).
    const live = [
      { sport: "NBA", name: "London Lions" },
      { sport: "NBA", name: "Portland Trail Blazers" },
      { sport: "NFL", name: "Detroit Lions" },
      { sport: "NFL", name: "Green Bay Packers" },
    ];
    // The live-team fallback itself resolves the name to the NBA game...
    const fallback = resolveLineAgainstLiveTeams("London Lions +20.5", live);
    check("live-team fallback: 'London Lions +20.5' -> the NBA game's London Lions", fallback.status === "resolved" ? { sport: fallback.sport, nickname: fallback.nickname } : fallback.status, { sport: "NBA", nickname: "london lions" });
    // ...and the NBA side of that game imports normally.
    check("'Blazers -20.5' -> NBA", first("Blazers -20.5")?.sportName, "NBA");
    // KNOWN GAP (reported, not fixed here): the fallback only sees lines the
    // parser left unresolved, and the parser reads "Lions" as the NFL/KBO
    // nickname first - so the exhibition side never reaches it. Pinned so a
    // future fix has to update this deliberately.
    const lions = first("London Lions +20.5");
    check("KNOWN GAP: 'London Lions +20.5' is read as the ambiguous 'lions' nickname, not left for the live fallback", { key: lions?.ambiguousKey, unresolved: parse("London Lions +20.5").unresolved }, { key: "lions", unresolved: [] });
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
