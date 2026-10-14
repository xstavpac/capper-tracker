// Proof that a city (or its abbreviation) plus a nickname resolves to that one
// team at import, with no prompt - run with:
//   npx tsx src/lib/city-nickname-resolution-acceptance-test.ts
//
// No test framework in this repo (see parse-catalog-acceptance-test.ts's
// header). console.logs PASS/FAIL, exits non-zero on any failure.
//
//   PART A - the reported lines ("LA Kings", "Vegas Knights", "Tampa Bay Rays")
//            and the rest of the rule: abbreviations, a whole word of a
//            nickname, a school in front of a pro mascot, city and nickname apart.
//   PART B - what must not change: a bare shared nickname still asks, a bare
//            partial word is not a team, an abbreviation is not a team alone.
//   PART C - the audit: every NFL, NBA, NHL, MLB, WNBA and NCAAF team, by full
//            official name and by city / abbreviation + nickname.
//   PART D - a prompt never offers a league outside its season.
import {
  parseCatalog,
  findTeamNickname,
  TEAM_NICKNAME_CANONICAL,
  NCAAF_CANONICAL_SUFFIX,
  CITY_NICKNAME_COLLISIONS,
} from "./parse-catalog";
import { runAmbiguousHierarchy, type ScheduleChecker, type ScheduleCheckQuery } from "./ambiguous-hierarchy";
import { teamNameEndsWith } from "./team-name-match";
import { SPORT_LABEL_TO_KEY, isSportLabelInSeason } from "./sport-seasons";
import { PRO_TEAMS as TEAMS } from "./__fixtures__/pro-teams";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const parse = (line: string) => parseCatalog(`Cap\n${line}`, []);
const first = (line: string) => parse(line).picks[0];
const title = (s: string) => s.replace(/(^|[\s(-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

// Every team a game can be between, per league, as the score feed spells it.
const LEAGUE_TEAMS: Record<string, string[]> = { NCAAF: [...new Set(Object.values(NCAAF_CANONICAL_SUFFIX))].map(title) };
for (const [league, name] of TEAMS) (LEAGUE_TEAMS[league] ??= []).push(name);

// null when `line` imports as one unprompted pick in `league` whose team
// nickname - translated the way bulk-picks.ts does before its game lookup -
// matches `team` and no other team in that league. Otherwise, what went wrong.
function whyNotUnique(line: string, league: string, team: string): string | null {
  const result = parse(line);
  if (result.picks.length !== 1) return `no pick (unresolved ${JSON.stringify(result.unresolved)})`;
  const pick = result.picks[0];
  if (pick.ambiguous) return `prompt [${pick.ambiguous.map((o) => o.label).join(" / ")}]`;
  if (pick.sportName !== league) return `read as ${pick.sportName}`;
  const nicknames = [...new Set(pick.teamNicknames.map((n) => TEAM_NICKNAME_CANONICAL[n] ?? n))];
  if (nicknames.length !== 1) return `team nicknames ${JSON.stringify(nicknames)}`;
  const hits = LEAGUE_TEAMS[league].filter((n) => teamNameEndsWith(n, nicknames[0], SPORT_LABEL_TO_KEY[league]));
  if (hits.length !== 1 || hits[0] !== team) return `"${nicknames[0]}" matches ${hits.length === 0 ? "no team" : hits.join(" + ")}`;
  return null;
}

function fakeSchedule(playing: string[]): ScheduleChecker {
  const set = new Set(playing);
  return async (queries: ScheduleCheckQuery[]) => {
    const out: Record<string, boolean> = {};
    for (const q of queries) out[q.nickname + "|" + q.sport] = set.has(q.nickname + "|" + q.sport);
    return out;
  };
}

async function main() {
  console.log("########## PART A: city + nickname is one team, no prompt ##########");
  {
    const cases: [string, string, string][] = [
      ["LA Kings Moneyline", "NHL", "Los Angeles Kings"],
      ["L.A. Kings ML", "NHL", "Los Angeles Kings"],
      ["Los Angeles Kings Moneyline", "NHL", "Los Angeles Kings"],
      ["LA Clippers Moneyline", "NBA", "LA Clippers"],
      ["LA Lakers Moneyline", "NBA", "Los Angeles Lakers"],
      ["LA Rams Moneyline", "NFL", "Los Angeles Rams"],
      ["LA Chargers Moneyline", "NFL", "Los Angeles Chargers"],
      ["LA Dodgers Moneyline", "MLB", "Los Angeles Dodgers"],
      ["LA Angels Moneyline", "MLB", "Los Angeles Angels"],
      ["Vegas Knights Moneyline", "NHL", "Vegas Golden Knights"],
      ["Las Vegas Knights -1.5", "NHL", "Vegas Golden Knights"],
      ["Vegas Golden Knights Moneyline", "NHL", "Vegas Golden Knights"],
      ["Vegas Raiders Moneyline", "NFL", "Las Vegas Raiders"],
      ["NY Rangers Moneyline", "NHL", "New York Rangers"],
      ["NY Knicks Moneyline", "NBA", "New York Knicks"],
      ["NY Giants -3", "NFL", "New York Giants"],
      ["SF Giants ML", "MLB", "San Francisco Giants"],
      ["SAC Kings +4.5", "NBA", "Sacramento Kings"],
      ["Tampa Bay Rays Moneyline", "MLB", "Tampa Bay Rays"],
      ["Tampa Bay Rays +1.5", "MLB", "Tampa Bay Rays"],
      ["TB Rays ML", "MLB", "Tampa Bay Rays"],
      ["KC Royals ML", "MLB", "Kansas City Royals"],
      ["OKC Thunder -6.5", "NBA", "Oklahoma City Thunder"],
      ["Philly Eagles -3", "NFL", "Philadelphia Eagles"],
      // A whole word of the nickname, next to the city.
      ["Detroit Wings ML", "NHL", "Detroit Red Wings"],
      ["Columbus Jackets ML", "NHL", "Columbus Blue Jackets"],
      ["Chicago Sox ML", "MLB", "Chicago White Sox"],
      ["Minnesota Gophers -7", "NCAAF", "Minnesota Golden Gophers"],
      // A school in front of a mascot a pro team also uses.
      ["USF Bulls ML", "NCAAF", "South Florida Bulls"],
      ["ECU Pirates +3.5", "NCAAF", "East Carolina Pirates"],
      ["Duke Devils ML", "NCAAF", "Duke Blue Devils"],
      // City and nickname apart on the line.
      ["Kings - Sacramento ML", "NBA", "Sacramento Kings"],
      ["Rangers (Texas) ML", "MLB", "Texas Rangers"],
    ];
    for (const [line, league, team] of cases) check(`'${line}' -> ${team} (${league})`, whyNotUnique(line, league, team), null);
  }

  console.log("\n########## PART B: what must NOT change ##########");
  {
    const kings = first("Kings Moneyline");
    check("'Kings Moneyline' alone is still the kings question", { key: kings?.ambiguousKey, options: kings?.ambiguous?.map((o) => o.label) }, {
      key: "kings",
      options: ["Sacramento Kings (NBA)", "Los Angeles Kings (NHL)"],
    });
    const knights = parse("Knights Moneyline");
    check("'Knights Moneyline' alone is not read as the Golden Knights", knights.picks.filter((p) => p.sportName === "NHL").length, 0);
    check("'Wings ML' alone is still the WNBA Wings", first("Wings ML")?.sportName, "WNBA");
    check("'Dallas Wings ML' is still the WNBA Wings", whyNotUnique("Dallas Wings ML", "WNBA", "Dallas Wings"), null);
    check("'Vegas Moneyline' alone is still the Las Vegas question", first("Vegas Moneyline")?.ambiguousKey, "vegas");
    check("'Bulls ML' alone is still the NBA Bulls", first("Bulls ML")?.sportName, "NBA");
    check("'Tampa Bay Rays Moneyline' keeps the nickname it always had", first("Tampa Bay Rays Moneyline")?.teamNicknames, ["rays"]);
    check("'Chisox ML' keeps its alias", first("Chisox ML")?.teamNicknames, ["chisox"]);
    // An abbreviation is only ever read in front of a nickname.
    check("'LA Moneyline' is not a team on its own", parse("LA Moneyline").picks.filter((p) => p.sportName || p.ambiguous).length, 0);
    // Two teams, two leagues' worth of options: still a matchup, not one team.
    check("'Giants at Dallas ML' is still a two-team NFL line", { sport: first("Giants at Dallas ML")?.sportName, n: first("Giants at Dallas ML")?.teamNicknames.length }, { sport: "NFL", n: 2 });
    check("no city + nickname phrase is claimed by two teams", CITY_NICKNAME_COLLISIONS, []);
    // A game card's team still maps to the short form a pick's text carries
    // (picks.ts matches free-text picks to a card by it).
    check(
      "a card team's short nickname is unchanged",
      ["San Jose State Spartans", "Sam Houston State Bearkats", "Connecticut Huskies"].map((team) => findTeamNickname(team, "NCAAF")),
      ["san jose state", "sam houston state", "connecticut"]
    );
    // The Angels are a Los Angeles team: a bare "Los Angeles" can mean them.
    check(
      "'Los Angeles ML' alone offers the Angels alongside the Dodgers",
      first("Los Angeles ML")?.ambiguous?.filter((o) => o.sport === "MLB").map((o) => o.label),
      ["Los Angeles Dodgers (MLB)", "Los Angeles Angels (MLB)"]
    );
    const onlyAngels = await runAmbiguousHierarchy([first("Los Angeles ML")], {}, {
      runScheduleCheck: fakeSchedule(["los angeles angels|MLB"]),
      runWideScheduleCheck: fakeSchedule([]),
      now: new Date("2026-07-15T17:00:00Z"),
    });
    check(
      "'Los Angeles ML' on a day only the Angels play -> the Angels",
      { sport: onlyAngels.picks[0].sportName, team: onlyAngels.picks[0].teamNicknames },
      { sport: "MLB", team: ["los angeles angels"] }
    );
  }

  console.log("\n########## PART C: audit - every team, every league ##########");
  {
    // "<full official name>" and "<city or abbreviation> <nickname>", each as a
    // moneyline and as a spread. Lines that fail for a reason OTHER than the
    // city + nickname rule are pinned here, so a fix (or a new failure) has to
    // update this list deliberately:
    //   - Hawai'i / San José typed with the accent: the school keys are plain
    //     ascii; the live game feed (not used here) is what reads those.
    const KNOWN: Record<string, string> = {
      "Hawai'i Rainbow Warriors": "team nicknames []",
      "San José State Spartans": "team nicknames []",
    };
    const failed: string[] = [];
    let lines = 0;
    const run = (subject: string, bet: string, league: string, team: string) => {
      lines++;
      const why = whyNotUnique(`${subject} ${bet}`, league, team);
      if ((why ?? undefined) !== KNOWN[subject]) failed.push(`${league} '${subject} ${bet}' -> ${why ?? "resolved, but is pinned as a known failure"}`);
    };
    for (const [league, name, cities, nickname] of TEAMS) {
      for (const bet of ["Moneyline", "+1.5"]) {
        run(name, bet, league, name);
        for (const city of cities) run(`${city} ${nickname}`, bet, league, name);
      }
    }
    for (const [key, canonical] of Object.entries(NCAAF_CANONICAL_SUFFIX)) {
      const name = title(canonical);
      run(name, "Moneyline", "NCAAF", name);
      const mascot = canonical.split(" ").pop()!;
      if (!key.endsWith(mascot) && !key.includes("(")) run(`${title(key)} ${title(mascot)}`, "Moneyline", "NCAAF", name);
    }
    console.log(`audited ${lines} lines across ${Object.keys(LEAGUE_TEAMS).join(", ")}`);
    check("every audited line resolves to its one team (bar the pinned known failures)", failed, []);
  }

  console.log("\n########## PART D: no out-of-season league in a prompt ##########");
  {
    const NOV = new Date("2026-11-15T17:00:00Z"); // WNBA and MLB are over; NFL, NBA, NHL, NCAAF are on.
    const prompt = async (line: string, playing: string[], extra: Partial<Parameters<typeof runAmbiguousHierarchy>[2]> = {}) => {
      const res = await runAmbiguousHierarchy([first(line)], {}, {
        runScheduleCheck: fakeSchedule(playing),
        runWideScheduleCheck: fakeSchedule(playing),
        now: NOV,
        ...extra,
      });
      return res.stillAmbiguous[0]?.options.map((o) => o.label) ?? `resolved ${res.picks[0].sportName}`;
    };
    check(
      "'Vegas Moneyline' in November, Raiders and Golden Knights both playing -> prompt without the Aces",
      await prompt("Vegas Moneyline", ["las vegas raiders|NFL", "vegas golden knights|NHL"]),
      ["Las Vegas Raiders (NFL)", "Vegas Golden Knights (NHL)"]
    );
    check(
      "'New York Moneyline' in November, nobody playing -> no MLB, no WNBA",
      await prompt("New York Moneyline", []),
      ["New York Giants (NFL)", "New York Jets (NFL)", "New York Knicks (NBA)", "New York Rangers (NHL)", "New York Islanders (NHL)"]
    );
    check(
      "a league the feeds show playing is kept whatever the calendar says",
      await prompt("Vegas Moneyline", ["las vegas raiders|NFL", "vegas golden knights|NHL"], {
        runLeagueActivityCheck: async () => ({ NFL: true, NHL: true, WNBA: true }),
      }),
      ["Las Vegas Raiders (NFL)", "Vegas Golden Knights (NHL)", "Las Vegas Aces (WNBA)"]
    );
    // During the WNBA Finals (Oct 17 - 31, 2026) the two finalists' cities
    // keep their WNBA team: the season window covers the whole series.
    const OCT25 = new Date("2026-10-25T17:00:00Z");
    check(
      "'Golden State ML' on Oct 25, nobody playing today -> still offers the Valkyries",
      await prompt("Golden State ML", [], { now: OCT25 }),
      ["Golden State Warriors (NBA)", "Golden State Valkyries (WNBA)"]
    );
    check(
      "'Atlanta ML' on Oct 25, only the Dream playing -> WNBA",
      await prompt("Atlanta ML", ["atlanta dream|WNBA"], { now: OCT25 }),
      "resolved WNBA"
    );
    check(
      "'Atlanta ML' on Oct 25, nobody playing -> the Dream are still on the list",
      ((await prompt("Atlanta ML", [], { now: OCT25 })) as string[]).includes("Atlanta Dream (WNBA)"),
      true
    );
    // Every city and shared-nickname key, nobody playing: whatever is left to
    // ask about, no option is from a league outside its season.
    const offSeason: string[] = [];
    for (const key of ["vegas", "las vegas", "los angeles", "new york", "chicago", "tampa bay", "st. louis", "kings", "rangers", "giants", "cardinals", "panthers", "jets", "liberty", "seattle", "phoenix", "minnesota", "washington"]) {
      const res = await runAmbiguousHierarchy([first(`${title(key)} Moneyline`)], {}, {
        runScheduleCheck: fakeSchedule([]),
        runWideScheduleCheck: fakeSchedule([]),
        now: NOV,
      });
      for (const group of res.stillAmbiguous) {
        for (const o of group.options) if (!isSportLabelInSeason(o.sport, NOV)) offSeason.push(`${key}: ${o.label}`);
      }
    }
    check("no prompt offers an out-of-season league", offSeason, []);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
