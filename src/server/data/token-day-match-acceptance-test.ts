// Bot API tokens, PR 3: the day rule API_TOKEN batches match games by (resolveTokenDayGameFromFeeds, odds.ts, and
// namedPickDay, lib/ingest-line-outcome.ts), against fixed feeds. The rule:
//   - the day is the Eastern calendar date the request arrives (midnight ET cutoff, no 6 a.m. slate rollover)
//   - a pick that names a day or date ("Thu", "11/26") is matched to that day's game
//   - otherwise the team's game that day - upcoming, live or already FINAL - and never a later one
//   - a team with no game that day (an NFL pick sent on a Tuesday) gets its next game
// And Telegram / manual paste (resolveScheduleGameFromFeeds, no day rule) match exactly as before.
//
// No DB, no network. Run with:
//   npx tsx src/server/data/token-day-match-acceptance-test.ts
import { resolveScheduleGameFromFeeds, resolveTokenDayGameFromFeeds, type OddsGame, type ScoreGame, type TokenDayMatch } from "./odds";
import { teamNameEndsWith } from "@/lib/team-name-match";
import { namedPickDay, tokenRequestDay } from "@/lib/ingest-line-outcome";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const NBA = "basketball_nba";
const NFL = "americanfootball_nfl";
const score = (id: string, home: string, away: string, commenceTime: string, status: ScoreGame["status"]): ScoreGame => ({
  id,
  homeTeam: home,
  awayTeam: away,
  status,
  scores: null,
  commenceTime,
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
});
const odds = (id: string, home: string, away: string, commenceTime: string, sportKey: string): OddsGame =>
  ({ id, sportKey, homeTeam: home, awayTeam: away, commenceTime, bookmakers: [] }) as unknown as OddsGame;
const team = (sportKey: string, nickname: string) => (g: { homeTeam: string; awayTeam: string }) =>
  teamNameEndsWith(g.homeTeam, nickname, sportKey) || teamNameEndsWith(g.awayTeam, nickname, sportKey);
const celtics = team(NBA, "celtics");

// Request time as an Eastern wall-clock time in late November (EST, UTC-5).
const et = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);
const rule = (at: Date, text = "Celtics ML"): TokenDayMatch => {
  const requestDay = tokenRequestDay(at);
  return { requestDay, namedDay: namedPickDay(text, requestDay) };
};
const id = (r: { game: { id: string } | null }) => r.game?.id ?? null;

// Celtics: Monday 11/23 7:30 PM ET (final), Tuesday 11/24 7:30 PM ET, Thursday 11/26 7:30 PM ET (odds feed only).
const MON = "2026-11-24T00:30:00Z";
const TUE = "2026-11-25T00:30:00Z";
const THU = "2026-11-27T00:30:00Z";
const monFinal = score("mon", "Boston Celtics", "Miami Heat", MON, "final");
const tueGame = (status: ScoreGame["status"]) => score("tue", "Brooklyn Nets", "Boston Celtics", TUE, status);
const thuOdds = odds("thu", "Boston Celtics", "Orlando Magic", THU, NBA);

// ---- 1. the request day: Eastern calendar date, midnight cutoff ----
expect("request day at 11:30 PM ET Monday is Monday", tokenRequestDay(et("2026-11-23", "23:30")), "2026-11-23");
expect("request day at 12:30 AM ET Tuesday is Tuesday", tokenRequestDay(et("2026-11-24", "00:30")), "2026-11-24");

// ---- 2. named days and dates ----
const TUESDAY = "2026-11-24";
expect("Thursday -> 11/26", namedPickDay("Thursday Celtics ML", TUESDAY), "2026-11-26");
expect("Thu -> 11/26", namedPickDay("Thu Celtics -3", TUESDAY), "2026-11-26");
expect("Thurs, at the end -> 11/26", namedPickDay("Celtics ML Thurs", TUESDAY), "2026-11-26");
expect("the same weekday as today -> today", namedPickDay("Tuesday Celtics ML", TUESDAY), TUESDAY);
expect("Monday on a Tuesday -> next Monday", namedPickDay("Mon Celtics ML", TUESDAY), "2026-11-30");
expect("Sunday -> 11/29", namedPickDay("Sunday Bills ML", TUESDAY), "2026-11-29");
expect("Sun is the WNBA's Connecticut Sun, not Sunday", namedPickDay("Sun +4.5", TUESDAY), null);
expect("11/27 -> 2026-11-27", namedPickDay("11/27 Celtics ML", TUESDAY), "2026-11-27");
expect("(11/27) in parentheses -> 2026-11-27", namedPickDay("Celtics ML (11/27)", TUESDAY), "2026-11-27");
expect("1/2 in late November -> next January", namedPickDay("Celtics ML 1/2", TUESDAY), "2027-01-02");
expect("11/27/26 -> 2026-11-27", namedPickDay("Celtics ML 11/27/26", TUESDAY), "2026-11-27");
expect("a date wins over a weekday", namedPickDay("Thu 11/27 Celtics ML", TUESDAY), "2026-11-27");
expect("tonight -> today, tomorrow -> tomorrow", [namedPickDay("Celtics ML tonight", TUESDAY), namedPickDay("Celtics tomorrow", TUESDAY)], [TUESDAY, "2026-11-25"]);
expect("1/2u (units) is not a date", namedPickDay("Celtics ML 1/2u", TUESDAY), null);
expect("1/2 unit is not a date", namedPickDay("Celtics ML 1/2 unit", TUESDAY), null);
expect("no day named -> null", namedPickDay("Celtics -3.5 -110", TUESDAY), null);
expect("Thunder is not Thursday", namedPickDay("Thunder ML", TUESDAY), null);

// ---- 3. a named day: that day's game ----
{
  const at = et("2026-11-24", "10:00");
  const scores = [monFinal, tueGame("preview")];
  expect("'Thu Celtics ML' on Tuesday -> Thursday's game (odds feed)", id(resolveTokenDayGameFromFeeds(scores, [thuOdds], celtics, at, null, rule(at, "Thu Celtics ML"))), "thu");
  expect("'11/26 Celtics ML' -> Thursday's game", id(resolveTokenDayGameFromFeeds(scores, [thuOdds], celtics, at, null, rule(at, "11/26 Celtics ML"))), "thu");
  expect("'Mon Celtics ML' named on Tuesday -> next Monday: no game listed, no match (never another day)", id(resolveTokenDayGameFromFeeds(scores, [thuOdds], celtics, at, null, rule(at, "Mon Celtics ML"))), null);
  expect("'Wednesday Celtics ML' -> no game that day, no match", id(resolveTokenDayGameFromFeeds(scores, [thuOdds], celtics, at, null, rule(at, "Wednesday Celtics ML"))), null);
}

// ---- 4. same day: upcoming, live, final ----
{
  const morning = et("2026-11-24", "10:00");
  expect("same day, upcoming -> today's game", id(resolveTokenDayGameFromFeeds([monFinal, tueGame("preview")], [thuOdds], celtics, morning, null, rule(morning))), "tue");
  const during = et("2026-11-24", "20:30");
  expect("same day, live -> today's game", id(resolveTokenDayGameFromFeeds([monFinal, tueGame("live")], [thuOdds], celtics, during, null, rule(during))), "tue");
  const late = et("2026-11-24", "23:00");
  const finalToday = [monFinal, tueGame("final")];
  expect("same day, FINAL -> today's game is still accepted (never Thursday's)", id(resolveTokenDayGameFromFeeds(finalToday, [thuOdds], celtics, late, null, rule(late))), "tue");
  // Telegram (realTimeIngest -> excludeFinal) is unchanged: the same post skips the finished game.
  expect("Telegram, same feeds: the finished game is excluded, as before", id(resolveScheduleGameFromFeeds(finalToday, [thuOdds], celtics, late, null, [], { excludeFinal: true, sportKey: NBA })), "thu");
  expect("manual paste, same feeds: today's finished game, as before", id(resolveScheduleGameFromFeeds(finalToday, [thuOdds], celtics, late)), "tue");
}

// ---- 5. 11:30 PM ET vs 12:30 AM ET ----
{
  const scores = [monFinal, tueGame("preview")];
  const beforeMidnight = et("2026-11-23", "23:30");
  const afterMidnight = et("2026-11-24", "00:30");
  expect("11:30 PM ET Monday -> Monday's (final) game", id(resolveTokenDayGameFromFeeds(scores, [], celtics, beforeMidnight, null, rule(beforeMidnight))), "mon");
  expect("12:30 AM ET Tuesday -> Tuesday's game (midnight is the cutoff)", id(resolveTokenDayGameFromFeeds(scores, [], celtics, afterMidnight, null, rule(afterMidnight))), "tue");
  // Unchanged for Telegram / paste: their slate day still rolls at 6 a.m. ET, so 12:30 AM is still Monday's slate.
  expect("manual paste at 12:30 AM ET: Monday's game, as before (6 a.m. slate rollover)", id(resolveScheduleGameFromFeeds(scores, [], celtics, afterMidnight)), "mon");
}

// ---- 6. no game today: the next game ----
{
  const bills = team(NFL, "bills");
  const tuesday = et("2026-11-24", "11:00");
  const lastSunday = score("nfl-last", "Buffalo Bills", "New York Jets", "2026-11-22T18:00:00Z", "final");
  const nextSunday = odds("nfl-next", "Pittsburgh Steelers", "Buffalo Bills", "2026-11-29T18:00:00Z", NFL);
  const later = odds("nfl-later", "Buffalo Bills", "Miami Dolphins", "2026-12-06T18:00:00Z", NFL);
  expect("NFL team, no game Tuesday -> its next game (Sunday), not last Sunday's final", id(resolveTokenDayGameFromFeeds([lastSunday], [later, nextSunday], bills, tuesday, null, rule(tuesday, "Bills ML"), [], NFL)), "nfl-next");
  expect("no game today and nothing ahead -> no match (never a past game)", id(resolveTokenDayGameFromFeeds([lastSunday], [], bills, tuesday, null, rule(tuesday, "Bills ML"), [], NFL)), null);
  // The next game is read from the score feed too (an upcoming game tomorrow), and its odds twin is not doubled.
  const wed = et("2026-11-24", "09:00");
  const tomorrowScore = score("wed-score", "Boston Celtics", "Chicago Bulls", "2026-11-26T00:30:00Z", "preview");
  const tomorrowOdds = odds("wed-odds", "Boston Celtics", "Chicago Bulls", "2026-11-26T00:31:00Z", NBA);
  expect("no game today, tomorrow in the score feed -> tomorrow's game", id(resolveTokenDayGameFromFeeds([monFinal, tomorrowScore], [tomorrowOdds, thuOdds], celtics, wed, null, rule(wed), [], NBA)), "wed-score");
}

// ---- 7. never skip ahead while the team plays that day ----
{
  const at = et("2026-11-24", "23:59");
  const tomorrowScore = score("wed", "Boston Celtics", "Chicago Bulls", "2026-11-26T00:30:00Z", "preview");
  expect("today's final + tomorrow's upcoming -> today's final", id(resolveTokenDayGameFromFeeds([tueGame("final"), tomorrowScore], [thuOdds], celtics, at, null, rule(at))), "tue");
}

// ---- 8. postponed / cancelled games are never the day's game ----
{
  const at = et("2026-11-24", "10:00");
  expect("a postponed game today is not today's game -> the next one", id(resolveTokenDayGameFromFeeds([tueGame("postponed" as ScoreGame["status"])], [thuOdds], celtics, at, null, rule(at))), "thu");
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll token day-rule matching checks passed.");
