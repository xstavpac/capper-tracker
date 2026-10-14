// Proof that a team nickname only matches a game team on whole words - run with:
//   npx tsx src/server/data/team-name-whole-word-acceptance-test.ts
//
// No test framework in this repo (see parse-catalog-acceptance-test.ts's
// header). console.logs PASS/FAIL, exits non-zero on any failure.
//
// "Charlotte Hornets" ends with the letters "nets". The game match used to be
// a bare endsWith, so a Nets pick could attach to a Hornets game.
//
//   PART A - the matcher itself, including the spellings it must keep matching.
//   PART B - a Nets pick finds the Nets game, never the Hornets', when both
//            play the same day; and keeps its side when they play each other.
//   PART C - the audit: every nickname of every team in every league against
//            every other team's name, for an ending that starts mid-word.
//   PART D - the team color lookup, which had the same bare suffix test.
import { resolveScheduleGameFromFeeds } from "./odds";
import type { ScoreGame } from "./odds";
import { teamNameEndsWith, endsWithWholeWords, sideForNickname } from "@/lib/team-name-match";
import { parseCatalog, TEAM_NICKNAME_CANONICAL, NCAAF_CANONICAL_SUFFIX } from "@/lib/parse-catalog";
import { SPORT_LABEL_TO_KEY } from "@/lib/sport-seasons";
import { getTeamColor } from "@/lib/team-colors";
import { PRO_TEAMS } from "@/lib/__fixtures__/pro-teams";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const title = (s: string) => s.replace(/(^|[\s(-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// Every team per league, as the score feed spells it.
const LEAGUE_TEAMS: Record<string, string[]> = { NCAAF: [...new Set(Object.values(NCAAF_CANONICAL_SUFFIX))].map(title) };
for (const [league, name] of PRO_TEAMS) (LEAGUE_TEAMS[league] ??= []).push(name);

const NOW = new Date("2026-11-10T22:00:00Z");
const game = (home: string, away: string, hourUtc = 0): ScoreGame => ({
  id: `${away}@${home}`,
  homeTeam: home,
  awayTeam: away,
  status: "preview",
  scores: null,
  commenceTime: `2026-11-11T${String(hourUtc).padStart(2, "0")}:30:00Z`,
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
});
// What bulk-picks.ts does with a one-team line: parse it, translate the
// nickname, and ask the schedule for a game whose home or away team ends with it.
function gameFor(line: string, league: string, slate: ScoreGame[]): string | null {
  const pick = parseCatalog(`Cap\n${line}`, []).picks[0];
  if (!pick || pick.sportName !== league || pick.teamNicknames.length !== 1) return `not one ${league} team: ${JSON.stringify(pick?.teamNicknames)}`;
  const nickname = TEAM_NICKNAME_CANONICAL[pick.teamNicknames[0]] ?? pick.teamNicknames[0];
  const sportKey = SPORT_LABEL_TO_KEY[league];
  const found = resolveScheduleGameFromFeeds(
    slate,
    [],
    (g) => teamNameEndsWith(g.homeTeam, nickname, sportKey) || teamNameEndsWith(g.awayTeam, nickname, sportKey),
    NOW
  ).game;
  return found ? `${found.awayTeam} @ ${found.homeTeam}` : null;
}

function main() {
  console.log("########## PART A: the matcher ##########");
  {
    check("'nets' ends Brooklyn Nets", teamNameEndsWith("Brooklyn Nets", "nets", "basketball_nba"), true);
    check("'nets' does not end Charlotte Hornets", teamNameEndsWith("Charlotte Hornets", "nets", "basketball_nba"), false);
    check("'hornets' ends Charlotte Hornets", teamNameEndsWith("Charlotte Hornets", "hornets", "basketball_nba"), true);
    // Everything that matched for the right reason still does.
    check("a full name ends itself", teamNameEndsWith("Los Angeles Kings", "los angeles kings", "icehockey_nhl"), true);
    check("a multi-word nickname", teamNameEndsWith("Boston Red Sox", "red sox", "baseball_mlb"), true);
    check("the last word of a multi-word nickname", teamNameEndsWith("Detroit Red Wings", "wings", "icehockey_nhl"), true);
    check("a nickname that starts with a digit", teamNameEndsWith("San Francisco 49ers", "49ers", "americanfootball_nfl"), true);
    check("a period in the feed's name", teamNameEndsWith("St. Louis Cardinals", "st louis cardinals", "baseball_mlb"), true);
    check("an accent and apostrophe in the nickname", teamNameEndsWith("Hawaii Rainbow Warriors", "hawai'i rainbow warriors", "americanfootball_ncaaf"), true);
    check("an alias row's other spelling", teamNameEndsWith("LA Clippers", "los angeles clippers", "basketball_nba"), true);
    check("an alias row's other spelling (NCAAF)", teamNameEndsWith("Appalachian State Mountaineers", "app state mountaineers", "americanfootball_ncaaf"), true);
    check("a hyphen is a word boundary", endsWithWholeWords("hamilton tiger-cats", "cats"), true);
    check("mid-word is not", endsWithWholeWords("kentucky wildcats", "cats"), false);
    check("an empty phrase matches nothing", endsWithWholeWords("brooklyn nets", ""), false);
  }

  console.log("\n########## PART B: a Nets pick and a Hornets game ##########");
  {
    // Hornets tip first, so "earliest matching game" would have been theirs.
    const slate = [game("New York Knicks", "Charlotte Hornets", 0), game("Boston Celtics", "Brooklyn Nets", 1), game("Miami Heat", "Chicago Bulls", 1)];
    check("'Nets ML', Nets and Hornets both playing -> the Nets game", gameFor("Nets ML", "NBA", slate), "Brooklyn Nets @ Boston Celtics");
    check("'Brooklyn Nets Moneyline' -> the Nets game", gameFor("Brooklyn Nets Moneyline", "NBA", slate), "Brooklyn Nets @ Boston Celtics");
    check("'Hornets ML' -> the Hornets game", gameFor("Hornets ML", "NBA", slate), "Charlotte Hornets @ New York Knicks");
    check(
      "'Nets ML' on a day only the Hornets play -> no game, not the Hornets'",
      gameFor("Nets ML", "NBA", [game("New York Knicks", "Charlotte Hornets")]),
      null
    );
    // Playing each other: both sides used to answer to "nets", so the pick had no side.
    const headToHead = { homeTeam: "Charlotte Hornets", awayTeam: "Brooklyn Nets" };
    check("Nets @ Hornets: 'nets' is the away side", sideForNickname(headToHead, "nets", "basketball_nba"), "AWAY");
    check("Nets @ Hornets: 'hornets' is the home side", sideForNickname(headToHead, "hornets", "basketball_nba"), "HOME");
  }

  console.log("\n########## PART C: audit - every nickname against every other team ##########");
  {
    // A team's nicknames: every run of whole words its name ends with
    // ("Vegas Golden Knights" -> "knights", "golden knights", and the full name).
    // An overlap is one of them ending ANOTHER team's name from mid-word.
    type Overlap = { league: string; nickname: string; owner: string; other: string; sameLeague: boolean };
    const overlaps: Overlap[] = [];
    const all = Object.entries(LEAGUE_TEAMS).flatMap(([league, names]) => names.map((name) => ({ league, name, folded: fold(name) })));
    for (const owner of all) {
      const words = owner.folded.split(" ");
      for (let i = 0; i < words.length; i++) {
        const nickname = words.slice(i).join(" ");
        for (const other of all) {
          if (other.name === owner.name || !other.folded.endsWith(nickname) || endsWithWholeWords(other.folded, nickname)) continue;
          overlaps.push({ league: owner.league, nickname, owner: owner.name, other: `${other.name} (${other.league})`, sameLeague: other.league === owner.league });
        }
      }
    }
    const show = (o: Overlap) => `${o.league} "${o.nickname}" (${o.owner}) ends ${o.other}`;
    console.log(`checked ${all.length} teams across ${Object.keys(LEAGUE_TEAMS).join(", ")}`);
    // Within one league - the only overlaps a game lookup can hit, since it is
    // always asked about one league's games.
    check(
      "overlaps inside one league",
      overlaps.filter((o) => o.sameLeague).map(show),
      [
        // "pack" alone is not a nickname the import ever produces (Nevada resolves by its
        // full name), so only the Nets overlap could reach a real pick.
        `NCAAF "pack" (Nevada Wolf Pack) ends Nc State Wolfpack (NCAAF)`,
        `NBA "nets" (Brooklyn Nets) ends Charlotte Hornets (NBA)`,
      ]
    );
    // Across leagues - harmless to a game lookup, listed so a change shows up.
    check(
      "overlaps across leagues",
      overlaps.filter((o) => !o.sameLeague).map(show).sort(),
      [
        `NBA "hawks" (Atlanta Hawks) ends Chicago Blackhawks (NHL)`,
        `NBA "hawks" (Atlanta Hawks) ends Kansas Jayhawks (NCAAF)`,
        `NBA "hawks" (Atlanta Hawks) ends Miami (Oh) Redhawks (NCAAF)`,
        `NBA "hawks" (Atlanta Hawks) ends Seattle Seahawks (NFL)`,
        `NBA "hawks" (Atlanta Hawks) ends Ul Monroe Warhawks (NCAAF)`,
        `NBA "kings" (Sacramento Kings) ends Minnesota Vikings (NFL)`,
        `NBA "nets" (Brooklyn Nets) ends Alabama State Hornets (NCAAF)`,
        `NBA "nets" (Brooklyn Nets) ends Sacramento State Hornets (NCAAF)`,
        `NCAAF "wolves" (Arkansas State Red Wolves) ends Minnesota Timberwolves (NBA)`,
        `NHL "kings" (Los Angeles Kings) ends Minnesota Vikings (NFL)`,
      ]
    );
    // Every overlap, either kind: the nickname answers to its owner only.
    const wrong: string[] = [];
    for (const o of overlaps) {
      const otherName = o.other.replace(/ \([A-Z]+\)$/, "");
      for (const league of Object.keys(LEAGUE_TEAMS)) {
        const key = SPORT_LABEL_TO_KEY[league];
        if (!teamNameEndsWith(o.owner, o.nickname, key)) wrong.push(`${show(o)}: no longer matches its owner`);
        if (teamNameEndsWith(otherName, o.nickname, key)) wrong.push(`${show(o)}: still matches the other team`);
      }
    }
    check("every overlap matches its owner and not the other team", wrong, []);

    // And no team's own nickname stopped matching its own name.
    const lost: string[] = [];
    for (const { league, name, folded } of all) {
      const words = folded.split(" ");
      for (let i = 0; i < words.length; i++) {
        if (!teamNameEndsWith(name, words.slice(i).join(" "), SPORT_LABEL_TO_KEY[league])) lost.push(`${name}: ${words.slice(i).join(" ")}`);
      }
    }
    check("every team still answers to every whole-word ending of its own name", lost, []);
  }

  console.log("\n########## PART D: team colors ##########");
  {
    check("the Hornets get the Hornets' color, not the Nets'", getTeamColor("basketball_nba", "Charlotte Hornets"), "#1D1160");
    check("the Nets keep theirs", getTeamColor("basketball_nba", "Brooklyn Nets"), "#000000");
    check("a ranked schedule string still finds its school", getTeamColor("americanfootball_ncaaf", "#3 Ohio State Buckeyes"), "#BA0C2F");
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
