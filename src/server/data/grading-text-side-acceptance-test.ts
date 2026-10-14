// Proof for how gradePick reads a pick's side from its text when no side was
// stored at import - run with:
//   npx tsx src/server/data/grading-text-side-acceptance-test.ts
//
// No test framework in this repo (see parse-catalog-acceptance-test.ts's
// header). console.logs PASS/FAIL, exits non-zero on any failure.
//
// The fallback used to be `detail.includes(lastWordOfTeamName)` for each team.
// "hornets ml" contains "nets", so in a Nets - Hornets game a Hornets pick read
// as both sides and was graded as the home team's, whichever team that was.
//
//   PART A - Nets / Hornets: each pick grades its own side, home or away.
//   PART B - a mascot written flush ("RedSox ML") still grades.
//   PART C - text that answers to both teams is never graded on a side.
//   PART D - what must not change: a stored side wins, same-mascot matchups,
//            school names, totals.
//   PART E - audit: every pair of teams in one league where one mascot sits
//            inside the other's.
import { gradePick, textPickedSide, isTextSideAmbiguous } from "./grading";
import { NCAAF_CANONICAL_SUFFIX } from "@/lib/parse-catalog";
import { PRO_TEAMS } from "@/lib/__fixtures__/pro-teams";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// A moneyline with no stored side, home team winning 110-100 (or as given).
const ml = (detail: string, home: string, away: string, homeScore = 110, awayScore = 100) =>
  gradePick("MONEYLINE", detail, null, home, away, homeScore, awayScore, null);

const HORNETS = "Charlotte Hornets";
const NETS = "Brooklyn Nets";

console.log("########## PART A: Nets / Hornets ##########");
{
  // Hornets at home and winning.
  check("Hornets ML, Hornets home and win -> WIN", ml("Hornets ML", HORNETS, NETS), "WIN");
  check("Nets ML, Hornets home and win -> LOSS", ml("Nets ML", HORNETS, NETS), "LOSS");
  // Nets at home and winning: the case that used to grade a Hornets pick as the Nets'.
  check("Hornets ML, Nets home and win -> LOSS", ml("Hornets ML", NETS, HORNETS), "LOSS");
  check("Nets ML, Nets home and win -> WIN", ml("Nets ML", NETS, HORNETS), "WIN");
  check("Hornets ML, Nets home and lose -> WIN", ml("Hornets ML", NETS, HORNETS, 95, 104), "WIN");
  check("Charlotte Hornets Moneyline (-120) 2u, Nets home and win -> LOSS", ml("Charlotte Hornets Moneyline (-120) 2u", NETS, HORNETS), "LOSS");
  check(
    "Hornets +6.5 (away), lose by 4 -> WIN",
    gradePick("SPREAD", "Hornets +6.5", 6.5, NETS, HORNETS, 104, 100, null),
    "WIN"
  );
  check(
    "Nets -6.5 (home), win by 4 -> LOSS",
    gradePick("SPREAD", "Nets -6.5", -6.5, NETS, HORNETS, 104, 100, null),
    "LOSS"
  );
  check(
    "Hornets team total over 99.5 (away, scored 100) -> WIN",
    gradePick("TEAM_TOTAL", "Hornets over 99.5", 99.5, NETS, HORNETS, 104, 100, null),
    "WIN"
  );
  check("the text side itself: 'hornets ml' is the Hornets only", textPickedSide("Hornets ML", NETS, HORNETS), { home: false, away: true, ambiguous: false });
}

console.log("\n########## PART B: a mascot written flush ##########");
{
  check("RedSox ML, Red Sox home and win -> WIN", ml("RedSox ML", "Boston Red Sox", "New York Yankees", 5, 3), "WIN");
  check("RedSox ML, Red Sox away and win -> WIN", ml("RedSox ML", "New York Yankees", "Boston Red Sox", 3, 5), "WIN");
  check("BlueJays -1.5, Blue Jays home, win by 3 -> WIN", gradePick("SPREAD", "BlueJays -1.5", -1.5, "Toronto Blue Jays", "Tampa Bay Rays", 6, 3, null), "WIN");
  check("WhiteSox ML vs the Tigers, White Sox away and lose -> LOSS", ml("WhiteSox ML", "Detroit Tigers", "Chicago White Sox", 4, 2), "LOSS");
  // The flush match is only tried when neither mascot is there as a word.
  check("Yankees ML is not read as flush text for the other side", ml("Yankees ML", "Boston Red Sox", "New York Yankees", 5, 3), "LOSS");
}

console.log("\n########## PART C: both sides -> never graded on a side ##########");
{
  check("'Nets vs Hornets ML' -> pending", ml("Nets vs Hornets ML", NETS, HORNETS), null);
  check("'Nets vs Hornets ML', tied score -> still pending, not a push", ml("Nets vs Hornets ML", NETS, HORNETS, 100, 100), null);
  check("'Nets/Hornets -3.5' spread -> pending", gradePick("SPREAD", "Nets/Hornets -3.5", -3.5, NETS, HORNETS, 110, 100, null), null);
  check("'Nets Hornets over 99.5' team total -> pending", gradePick("TEAM_TOTAL", "Nets Hornets over 99.5", 99.5, NETS, HORNETS, 110, 100, null), null);
  check("flush text holding both mascots ('NetsHornets ML') -> pending", ml("NetsHornets ML", NETS, HORNETS), null);
  check("the pending-picks page can say why", isTextSideAmbiguous("MONEYLINE", "Nets vs Hornets ML", NETS, HORNETS, null), true);
  check("...and not for a pick that names one team", isTextSideAmbiguous("MONEYLINE", "Hornets ML", NETS, HORNETS, null), false);
  check("...nor for one with a stored side", isTextSideAmbiguous("MONEYLINE", "Nets vs Hornets ML", NETS, HORNETS, "AWAY"), false);
  // A game total has no side: naming both teams is how it is usually written.
  check("'Nets Hornets over 205.5' game total still grades", gradePick("TOTAL", "Nets Hornets over 205.5", 205.5, NETS, HORNETS, 110, 100, null), "WIN");
  check("...and is not flagged ambiguous", isTextSideAmbiguous("TOTAL", "Nets Hornets over 205.5", NETS, HORNETS, null), false);
}

console.log("\n########## PART D: what must not change ##########");
{
  check("a stored side wins over the text", gradePick("MONEYLINE", "Nets vs Hornets ML", null, NETS, HORNETS, 110, 100, "AWAY"), "LOSS");
  check("a stored side wins over the text (home)", gradePick("MONEYLINE", "Hornets ML", null, NETS, HORNETS, 110, 100, "HOME"), "WIN");
  check("an ordinary pick: Lakers ML, Lakers away and win", ml("Lakers ML", "Boston Celtics", "Los Angeles Lakers", 99, 104), "WIN");
  check("text naming neither team, not tied -> pending", ml("Moneyline", NETS, HORNETS), null);
  check("text naming neither team, tied -> PUSH (as before)", ml("Moneyline", NETS, HORNETS, 100, 100), "PUSH");
  // Same mascot: the mascot says nothing, the school name still does.
  check("Tigers ML in Clemson Tigers @ LSU Tigers -> pending", ml("Tigers ML", "LSU Tigers", "Clemson Tigers", 24, 17), null);
  check("LSU ML in Clemson Tigers @ LSU Tigers -> WIN", ml("LSU ML", "LSU Tigers", "Clemson Tigers", 24, 17), "WIN");
  check("Duke ML in Duke Blue Devils @ Arizona State Sun Devils -> LOSS", ml("Duke ML", "Arizona State Sun Devils", "Duke Blue Devils", 31, 20), "LOSS");
}

console.log("\n########## PART E: audit - one mascot inside another, same league ##########");
{
  // gradePick knows a team by the last word of its name. A pair is at risk
  // when one team's last word sits inside the other's ("nets" in "hornets"):
  // the longer one's pick used to read as both sides.
  const title = (s: string) => s.replace(/(^|[\s(-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
  const leagues: Record<string, string[]> = { NCAAF: [...new Set(Object.values(NCAAF_CANONICAL_SUFFIX))].map(title) };
  for (const [league, name] of PRO_TEAMS) (leagues[league] ??= []).push(name);
  const last = (name: string) => name.trim().split(/\s+/).pop()!.toLowerCase();

  const pairs: { league: string; short: string; long: string }[] = [];
  for (const [league, names] of Object.entries(leagues)) {
    for (const short of names) {
      for (const long of names) {
        if (last(short) !== last(long) && last(long).includes(last(short))) pairs.push({ league, short, long });
      }
    }
  }
  const mascotPairs = [...new Set(pairs.map((p) => `${p.league} ${last(p.short)} / ${last(p.long)}`))].sort();
  console.log(`${pairs.length} team pairs, ${mascotPairs.length} distinct mascot pairs:`);
  for (const m of mascotPairs) console.log("  " + m);
  check("the distinct mascot pairs", mascotPairs, [
    "NBA nets / hornets",
    "NCAAF cardinal / cardinals",
    "NCAAF hurricane / hurricanes",
    "NCAAF pack / wolfpack",
  ]);

  // Every pair, both teams' picks, both home/away arrangements: each grades its own side.
  const wrong: string[] = [];
  for (const { league, short, long } of pairs) {
    for (const [home, away] of [[short, long], [long, short]]) {
      for (const picked of [short, long]) {
        const detail = `${title(last(picked))} ML`;
        const expected = picked === home ? "WIN" : "LOSS"; // home wins 30-20
        const got = gradePick("MONEYLINE", detail, null, home, away, 30, 20, null);
        if (got !== expected) wrong.push(`${league} '${detail}' in ${away} @ ${home}: ${got}, expected ${expected}`);
      }
    }
  }
  check("every pick in every such pair grades its own side", wrong, []);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
