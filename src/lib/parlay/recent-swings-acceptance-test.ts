// Recent swings (recent-swings.ts): the sign conventions for favorites and
// underdogs, home and away; a missing line; the latest capture before kickoff
// when a game sits in several snapshot rows; an MLB doubleheader; and the
// cross-source team-name join. Pure - no DB (the SQL that feeds these shapes is
// server/data/recent-swings.ts). Run with:
//   npx tsx src/lib/parlay/recent-swings-acceptance-test.ts
import { assembleSwings, chooseLine, oddsSpellings, swingForTeam, type StoredLine, type SwingScore } from "@/lib/parlay/recent-swings";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const NFL = "americanfootball_nfl";
const MLB = "baseball_mlb";

function score(id: string, gameDate: string, homeTeam: string, awayTeam: string, homeScore: number, awayScore: number, gameNumber: number | null = null): SwingScore {
  return { externalId: id, gameDate, homeTeam, awayTeam, homeScore, awayScore, gameNumber };
}
function line(over: Partial<StoredLine> & Pick<StoredLine, "fetchDate" | "eventId" | "homeTeam" | "awayTeam" | "commenceTime">): StoredLine {
  return { homeSpread: null, spreadUpdatedAt: null, total: null, totalUpdatedAt: null, ...over };
}

// ============================================================================
// Sign conventions: favorites and underdogs, home and away
// ============================================================================
{
  // Home favorite -7 wins 27-17 (by 10): covers by 3. The away dog is +7, lost by 10: misses by 3.
  const s = score("g1", "2099-10-04T17:00:00Z", "Bears", "Packers", 27, 17);
  const chosen = { homeSpread: -7, total: 41.5, hoursBeforeStart: 6 };
  const home = swingForTeam(s, true, chosen);
  const away = swingForTeam(s, false, chosen);
  check("home favorite: margin +10, posted -7, covered by 3", [home.margin, home.postedSpread, home.coverMargin], [10, -7, 3]);
  check("away underdog in the same game: margin -10, posted +7, missed by 3", [away.margin, away.postedSpread, away.coverMargin], [-10, 7, -3]);
  check("totals: 44 scored on 41.5 is +2.5 for both teams", [home.actualTotal, home.postedTotal, home.totalMiss, away.totalMiss], [44, 41.5, 2.5, 2.5]);
  check("opponent and side", [home.opponent, home.home, away.opponent, away.home], ["Packers", true, "Bears", false]);
}
{
  // Home favorite -7 wins by only 3 (24-21): fails to cover by 4; the away dog +7 covers by 4 in a loss.
  const s = score("g2", "2099-10-11T17:00:00Z", "Bears", "Lions", 24, 21);
  const chosen = { homeSpread: -7, total: 50, hoursBeforeStart: 2 };
  check("favorite wins by 3 on -7: cover margin -4", swingForTeam(s, true, chosen).coverMargin, -4);
  check("underdog loses by 3 on +7: cover margin +4", swingForTeam(s, false, chosen).coverMargin, 4);
  check("a total that came in under: 45 on 50 is -5", swingForTeam(s, true, chosen).totalMiss, -5);
}
{
  // Home underdog +3.5 wins outright; away favorite -3.5 loses.
  const s = score("g3", "2099-10-18T17:00:00Z", "Jets", "Bills", 20, 13);
  const chosen = { homeSpread: 3.5, total: 40, hoursBeforeStart: 1 };
  check("home underdog +3.5 wins by 7: covered by 10.5", swingForTeam(s, true, chosen).coverMargin, 10.5);
  check("away favorite -3.5 loses by 7: -10.5, posted -3.5", [swingForTeam(s, false, chosen).postedSpread, swingForTeam(s, false, chosen).coverMargin], [-3.5, -10.5]);
}
{
  // A push: favorite -3 wins by exactly 3 -> cover margin 0.
  const s = score("g4", "2099-10-25T17:00:00Z", "Bears", "Vikings", 23, 20);
  check("a push is a cover margin of 0", swingForTeam(s, true, { homeSpread: -3, total: null, hoursBeforeStart: 1 }).coverMargin, 0);
}

// ============================================================================
// Missing lines: the game stays, with its scores only
// ============================================================================
{
  const s = score("m1", "2099-10-04T17:00:00Z", "Bears", "Packers", 27, 17);
  const swing = swingForTeam(s, true, null);
  check("no stored line: lineSource missing, scores kept", [swing.lineSource, swing.margin, swing.actualTotal], ["missing", 10, 44]);
  check("no stored line: every line-derived value is null", [swing.postedTotal, swing.totalMiss, swing.postedSpread, swing.coverMargin, swing.hoursBeforeStart], [null, null, null, null, null]);
  const all = assembleSwings(NFL, [s], [], 5);
  check("assembly keeps a game with no stored line for both teams", [all["Bears"].length, all["Packers"].length, all["Bears"][0].lineSource], [1, 1, "missing"]);
  // Only a total stored: stored, spread values null.
  const totalOnly = swingForTeam(s, true, { homeSpread: null, total: 40, hoursBeforeStart: 3 });
  check("a total with no spread is stored with null spread values", [totalOnly.lineSource, totalOnly.totalMiss, totalOnly.postedSpread, totalOnly.coverMargin], ["stored", 4, null, null]);
  // A line for another matchup the same day is no line for this game.
  const other = line({ fetchDate: "2099-10-04", eventId: "e9", homeTeam: "Bears", awayTeam: "Rams", commenceTime: "2099-10-04T17:00:00Z", homeSpread: -3, total: 40 });
  check("another opponent's line is not this game's", chosen(s, [other]), null);
}
function chosen(s: SwingScore, lines: StoredLine[], sport = NFL) {
  return chooseLine(s, lines, sport);
}

// ============================================================================
// A game in several snapshot rows: the latest capture before kickoff
// ============================================================================
{
  const s = score("l1", "2099-10-04T17:00:00Z", "Bears", "Packers", 27, 17);
  const base = { eventId: "e1", homeTeam: "Bears", awayTeam: "Packers", commenceTime: "2099-10-04T17:00:00Z" };
  const rows = [
    line({ ...base, fetchDate: "2099-09-30", homeSpread: -3, spreadUpdatedAt: "2099-09-30T15:00:00Z", total: 40, totalUpdatedAt: "2099-09-30T15:00:00Z" }),
    line({ ...base, fetchDate: "2099-10-04", homeSpread: -6.5, spreadUpdatedAt: "2099-10-04T11:00:00Z", total: 42.5, totalUpdatedAt: "2099-10-04T11:00:00Z" }),
    line({ ...base, fetchDate: "2099-10-02", homeSpread: -4.5, spreadUpdatedAt: "2099-10-02T15:00:00Z", total: 41, totalUpdatedAt: "2099-10-02T15:00:00Z" }),
  ];
  check("the latest row's line, whatever the array order", chosen(s, rows), { homeSpread: -6.5, total: 42.5, hoursBeforeStart: 6 });
  check("the earlier rows alone give the later of them", chosen(s, rows.slice(0, 1).concat(rows.slice(2))), { homeSpread: -4.5, total: 41, hoursBeforeStart: 50 });

  // A price stamped after kickoff is in play, not a posted line.
  const inPlay = [rows[2], line({ ...base, fetchDate: "2099-10-04", homeSpread: -21.5, spreadUpdatedAt: "2099-10-04T19:00:00Z", total: 60, totalUpdatedAt: "2099-10-04T19:00:00Z" })];
  check("a last_update after kickoff is never used", chosen(s, inPlay), { homeSpread: -4.5, total: 41, hoursBeforeStart: 50 });

  // Per market: the newest row has the spread only; the total comes from the older row.
  const split = [
    line({ ...base, fetchDate: "2099-10-02", total: 41, totalUpdatedAt: "2099-10-02T15:00:00Z" }),
    line({ ...base, fetchDate: "2099-10-04", homeSpread: -6.5, spreadUpdatedAt: "2099-10-04T11:00:00Z" }),
  ];
  check("each market takes its own latest capture; hours is the older one", chosen(s, split), { homeSpread: -6.5, total: 41, hoursBeforeStart: 50 });

  // No book timestamp: hours run from the start of the capture's Eastern day (an upper bound).
  const noStamp = [line({ ...base, fetchDate: "2099-10-04", homeSpread: -6.5, total: 42.5 })];
  const got = chosen(s, noStamp)!;
  check("no last_update: the capture day's start bounds the age", [got.homeSpread, got.total, got.hoursBeforeStart! > 0 && got.hoursBeforeStart! <= 17], [-6.5, 42.5, true]);

  const swings = assembleSwings(NFL, [s], rows, 5)["Bears"][0];
  check("assembled swing uses the latest capture", [swings.postedSpread, swings.postedTotal, swings.coverMargin, swings.totalMiss, swings.hoursBeforeStart, swings.lineSource], [-6.5, 42.5, 3.5, 1.5, 6, "stored"]);
}

// ============================================================================
// An MLB doubleheader: two events on one day
// ============================================================================
{
  const g1 = score("dh1", "2099-06-10T17:10:00Z", "Yankees", "Red Sox", 5, 2, 1);
  const g2 = score("dh2", "2099-06-10T23:05:00Z", "Yankees", "Red Sox", 3, 8, 2);
  const base = { homeTeam: "Yankees", awayTeam: "Red Sox", fetchDate: "2099-06-10" };
  const lines = [
    line({ ...base, eventId: "night", commenceTime: "2099-06-10T23:05:00Z", homeSpread: 1.5, total: 8, spreadUpdatedAt: "2099-06-10T14:00:00Z", totalUpdatedAt: "2099-06-10T14:00:00Z" }),
    line({ ...base, eventId: "day", commenceTime: "2099-06-10T17:10:00Z", homeSpread: -1.5, total: 9.5, spreadUpdatedAt: "2099-06-10T13:00:00Z", totalUpdatedAt: "2099-06-10T13:00:00Z" }),
  ];
  check("game 1 gets the first event's line", [chosen(g1, lines, MLB)!.homeSpread, chosen(g1, lines, MLB)!.total], [-1.5, 9.5]);
  check("game 2 gets the second event's line", [chosen(g2, lines, MLB)!.homeSpread, chosen(g2, lines, MLB)!.total], [1.5, 8]);
  const noNumber = (s: SwingScore) => ({ ...s, gameNumber: null });
  check("without a game number, the closest start wins (game 1)", chosen(noNumber(g1), lines, MLB)!.total, 9.5);
  check("without a game number, the closest start wins (game 2)", chosen(noNumber(g2), lines, MLB)!.total, 8);
  check("assembled: each game of the doubleheader has its own line, newest first", assembleSwings(MLB, [g1, g2], lines, 5)["Yankees"].map((s) => [s.postedTotal, s.coverMargin]), [[8, -3.5], [9.5, 1.5]]);
  // Only the nightcap's event is stored and the score is game 1: not its line.
  const onlyNight = [lines[0]];
  check("game 1 is not given the nightcap's line when only the nightcap is stored", chosen(g1, onlyNight, MLB), null);
  check("game 2 with its own event stored still matches", chosen(g2, onlyNight, MLB)!.total, 8);
  // A single event on a normal day, no game number: matched on the day.
  const single = score("s1", "2099-06-11T23:05:00Z", "Yankees", "Red Sox", 4, 1);
  check("a normal day's single event matches", chosen(single, [line({ ...base, fetchDate: "2099-06-11", eventId: "x", commenceTime: "2099-06-11T23:05:00Z", total: 8.5 })], MLB)!.total, 8.5);
  // The same teams the next day are another game.
  check("the same teams on another Eastern day are not this game", chosen(single, [line({ ...base, fetchDate: "2099-06-10", eventId: "y", commenceTime: "2099-06-10T23:05:00Z", total: 8.5 })], MLB), null);
}

// ============================================================================
// Per team: the last n, most recent first
// ============================================================================
{
  const scores = [
    score("a", "2099-10-01T17:00:00Z", "Bears", "Packers", 20, 10),
    score("b", "2099-10-08T17:00:00Z", "Lions", "Bears", 30, 27),
    score("c", "2099-10-15T17:00:00Z", "Bears", "Vikings", 13, 17),
    score("d", "2099-10-22T17:00:00Z", "Rams", "Bears", 24, 31),
  ];
  const bears = assembleSwings(NFL, scores, [], 3)["Bears"];
  check("last 3, most recent first", bears.map((g) => g.opponent), ["Rams", "Vikings", "Lions"]);
  check("home / away flags and margins from the team's side", bears.map((g) => [g.home, g.margin]), [[false, 7], [true, -4], [false, -3]]);
  check("another team only gets its own games", assembleSwings(NFL, scores, [], 3)["Packers"].map((g) => g.opponent), ["Bears"]);
}

// ============================================================================
// Team-name matching between the score feed and the odds feed
// ============================================================================
{
  const nhl = "icehockey_nhl";
  const s = score("n1", "2099-11-02T00:00:00Z", "Montréal Canadiens", "St. Louis Blues", 4, 2);
  const l = line({ fetchDate: "2099-11-01", eventId: "n", homeTeam: "Montreal Canadiens", awayTeam: "St Louis Blues", commenceTime: "2099-11-02T00:00:00Z", total: 6, totalUpdatedAt: "2099-11-01T20:00:00Z" });
  check("accents and 'St.' fold together", chosen(s, [l], nhl)!.total, 6);
  const ncaaf = "americanfootball_ncaaf";
  const a = score("c1", "2099-10-10T19:00:00Z", "App State Mountaineers", "Troy Trojans", 31, 24);
  const al = line({ fetchDate: "2099-10-08", eventId: "c", homeTeam: "Appalachian State Mountaineers", awayTeam: "Troy Trojans", commenceTime: "2099-10-10T19:00:00Z", homeSpread: -6.5, total: 52, spreadUpdatedAt: "2099-10-08T12:00:00Z" });
  check("an alias row joins the two spellings", [chosen(a, [al], ncaaf)!.homeSpread, chosen(a, [al], ncaaf)!.total], [-6.5, 52]);
  check("without the alias table the same names do not join (the gap the table closes)", chosen(a, [al], "americanfootball_nfl"), null);
  check("oddsSpellings: the alias partner is added", oddsSpellings("App State Mountaineers", ncaaf), ["App State Mountaineers", "Appalachian State Mountaineers"]);
  check("oddsSpellings: a name with no row is itself", oddsSpellings("Troy Trojans", ncaaf), ["Troy Trojans"]);
  check("oddsSpellings: aliases never cross sports", oddsSpellings("App State Mountaineers", MLB), ["App State Mountaineers"]);
}

if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll recent-swings checks passed");
