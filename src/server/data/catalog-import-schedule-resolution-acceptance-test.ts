// Proof for catalog-import game resolution over the two schedule feeds -
// run with:
//   npx tsx src/server/data/catalog-import-schedule-resolution-acceptance-test.ts
//
// The bug (investigated 2026-09-08): resolveGameForNickname / resolveGameForTeams
// only ever matched against getLiveScoresForSport, whose ESPN feed spans just
// ~yesterday..tomorrow. A weekly-sport capper posts a whole weekend's slate
// 2-4 days ahead, so every pick past the next ~24h silently failed to import
// ("Couldn't match N picks... NOT imported"). The full posted schedule was
// already in the system (the OddsSnapshot / odds feed).
//
// The fix: resolveScheduleGameFromFeeds - score feed first (authoritative for
// anything live/now), full odds feed as the fallback when the score feed has
// no upcoming match. This exercises the pure core directly; the async wrapper
// resolveScheduleGame just supplies real getLiveScoresForSport / getOddsForSport.
//
// No test framework in this repo (see odds-preseason-merge-acceptance-test.ts).
import { resolveScheduleGameFromFeeds, pickBestScheduleCandidate } from "./odds";
import type { OddsGame, ScoreGame } from "./odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}
function checkTrue(label: string, actual: boolean) {
  console.log(`${actual ? "PASS" : "FAIL"}: ${label}`);
  if (!actual) failures++;
}

// A Monday-evening ET import instant. All the game dates below are expressed
// relative to this so the ±7 Eastern-calendar-day window is deterministic.
const MON = new Date("2026-09-07T22:00:00-04:00"); // Mon Sep 7 2026, 10pm ET
const dayISO = (etDay: number, hourUtc = 17) =>
  `2026-09-${String(7 + etDay).padStart(2, "0")}T${String(hourUtc).padStart(2, "0")}:00:00Z`;

const score = (
  home: string,
  away: string,
  etDay: number,
  status: ScoreGame["status"] = "preview",
  id = `score-${home}-${away}-${etDay}`
): ScoreGame => ({
  id,
  homeTeam: home,
  awayTeam: away,
  status,
  scores: status === "preview" ? null : [{ name: home, score: "0" }, { name: away, score: "0" }],
  commenceTime: dayISO(etDay),
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
});

const odds = (home: string, away: string, etDay: number, id = `odds-${home}-${away}-${etDay}`): OddsGame => ({
  id,
  sportKey: "americanfootball_nfl",
  homeTeam: home,
  awayTeam: away,
  commenceTime: dayISO(etDay),
  bookmakers: [],
});

const endsWith = (nick: string) => (g: { homeTeam: string; awayTeam: string }) =>
  g.homeTeam.toLowerCase().endsWith(nick) || g.awayTeam.toLowerCase().endsWith(nick);

// ---------------------------------------------------------------------------
console.log("########## the reported failure: an advance-posted NFL slate ##########");
{
  // Monday paste. Score feed = Sun..Tue only (the NFL Kickoff game). Odds
  // feed = the full posted week.
  const scores = [score("Seattle Seahawks", "New England Patriots", 2 /* Wed */)];
  const oddsFeed = [
    odds("Seattle Seahawks", "New England Patriots", 2),
    odds("Cincinnati Bengals", "Tampa Bay Buccaneers", 6 /* Sun */),
    odds("Los Angeles Chargers", "Arizona Cardinals", 6),
    odds("Kansas City Chiefs", "Denver Broncos", 7 /* Mon */),
  ];

  // Before the fix: score feed has no "buccaneers" match and the odds feed
  // was never consulted -> null -> pick dropped as unmatched.
  const bucs = resolveScheduleGameFromFeeds(scores, oddsFeed, endsWith("buccaneers"), MON);
  check("Sunday Bucs pick (+6d) now resolves via the odds feed", bucs?.homeTeam, "Cincinnati Bengals");
  check("  ...to the right game", bucs?.awayTeam, "Tampa Bay Buccaneers");

  const chiefs = resolveScheduleGameFromFeeds(scores, oddsFeed, endsWith("chiefs"), MON);
  check("Monday-night Chiefs pick (+7d, window edge) resolves", chiefs?.homeTeam, "Kansas City Chiefs");

  // The in-window score-feed game is unchanged - still resolved from the
  // score feed (its id), not the odds feed.
  const opener = resolveScheduleGameFromFeeds(scores, oddsFeed, endsWith("seahawks"), MON);
  check("the Wed opener still resolves from the SCORE feed", opener?.id, "score-Seattle Seahawks-New England Patriots-2");
}

// ---------------------------------------------------------------------------
console.log("\n########## NCAAF: same shape, weekend slate posted mid-week ##########");
{
  const wed = new Date("2026-09-09T20:00:00-04:00");
  const scores: ScoreGame[] = []; // nothing in the Tue..Thu window
  const oddsFeed = [
    { ...odds("Alabama Crimson Tide", "Wisconsin Badgers", 4), sportKey: "americanfootball_ncaaf" },
    { ...odds("Georgia Bulldogs", "Clemson Tigers", 4), sportKey: "americanfootball_ncaaf" },
  ];
  const bama = resolveScheduleGameFromFeeds(scores, oddsFeed, endsWith("crimson tide"), wed);
  check("weekend Alabama pick resolves via odds feed", bama?.homeTeam, "Alabama Crimson Tide");
  check("odds-feed game carries a 'preview' status", bama?.status, "preview");
  checkTrue("odds-feed game has no live scores", bama?.scores === null);
}

// ---------------------------------------------------------------------------
console.log("\n########## daily sport (MLB): near game unchanged, +3d now works ##########");
{
  // Score feed has tomorrow's Dodgers game; odds feed has it plus two more.
  const scores = [score("Los Angeles Dodgers", "San Diego Padres", 1)];
  const oddsFeed = [
    odds("Los Angeles Dodgers", "San Diego Padres", 1),
    odds("Los Angeles Dodgers", "San Diego Padres", 2),
    odds("Los Angeles Dodgers", "San Francisco Giants", 4),
  ];

  const dodgers = resolveScheduleGameFromFeeds(scores, oddsFeed, endsWith("dodgers"), MON);
  check("MLB near game still resolves from the SCORE feed (not odds)", dodgers?.id, "score-Los Angeles Dodgers-San Diego Padres-1");

  // A pick for the Friday series opener (+4d) - not in the score feed at all.
  const scoresEmpty: ScoreGame[] = [];
  const fri = resolveScheduleGameFromFeeds(scoresEmpty, oddsFeed, endsWith("giants"), MON);
  check("MLB +4d pick resolves via odds feed", fri?.awayTeam, "San Francisco Giants");

  // Repeated matchup, score feed empty: prefer the one nearest the import.
  const seriesOnly = oddsFeed.filter((g) => g.awayTeam === "San Diego Padres");
  const nearest = resolveScheduleGameFromFeeds([], seriesOnly, endsWith("padres"), MON);
  check("repeated MLB matchup in odds feed -> closest to import time", nearest?.commenceTime, dayISO(1));
}

// ---------------------------------------------------------------------------
console.log("\n########## guardrails: window edge + fallback-not-merge ##########");
{
  const oddsFeed = [odds("Cincinnati Bengals", "Tampa Bay Buccaneers", 10 /* +10d */)];
  const tooFar = resolveScheduleGameFromFeeds([], oddsFeed, endsWith("buccaneers"), MON);
  check("a game +10d out (past the 7-day window) still does NOT resolve", tooFar, null);

  // Same team, same day, in BOTH feeds - must not be doubled / must return
  // the score-feed row (its id), the odds row is ignored.
  const both = resolveScheduleGameFromFeeds(
    [score("Kansas City Chiefs", "Los Angeles Chargers", 0, "preview", "SCORE_ID")],
    [odds("Kansas City Chiefs", "Los Angeles Chargers", 0, "ODDS_ID")],
    endsWith("chiefs"),
    MON
  );
  check("game in both feeds -> the SCORE feed row wins (fallback, not merge)", both?.id, "SCORE_ID");

  // Score feed's only match already FINAL, an upcoming game exists in the
  // odds feed -> the upcoming game is the better guess.
  const nextWeek = resolveScheduleGameFromFeeds(
    [score("Buffalo Bills", "Baltimore Ravens", -1, "final", "FINAL_ID")],
    [odds("Miami Dolphins", "Buffalo Bills", 6)],
    endsWith("bills"),
    MON
  );
  check("score feed only has a FINISHED game -> use the upcoming odds game", nextWeek?.homeTeam, "Miami Dolphins");

  // ...but if nothing is upcoming anywhere, the finished score-feed game is
  // still returned (logging a pick right after its game).
  const justEnded = resolveScheduleGameFromFeeds(
    [score("Buffalo Bills", "Baltimore Ravens", -1, "final", "FINAL_ID")],
    [],
    endsWith("bills"),
    MON
  );
  check("nothing upcoming -> the just-finished score game is still resolvable", justEnded?.id, "FINAL_ID");

  check("no match in either feed -> null", resolveScheduleGameFromFeeds([], [], endsWith("jets"), MON), null);
}

// ---------------------------------------------------------------------------
console.log("\n########## pickBestScheduleCandidate: same-day > not-final > closest ##########");
{
  const g = (day: number, status: ScoreGame["status"], id: string) => score("H", "A", day, status, id);
  check("single candidate is returned as-is", pickBestScheduleCandidate([g(3, "preview", "one")], MON)?.id, "one");
  check(
    "same Eastern day beats a closer-in-absolute-time other day",
    pickBestScheduleCandidate([g(0, "preview", "sameday"), g(1, "preview", "nextday")], MON)?.id,
    "sameday"
  );
  check(
    "within the day, a not-final game beats a final one",
    pickBestScheduleCandidate([g(0, "final", "done"), g(0, "preview", "upcoming")], MON)?.id,
    "upcoming"
  );
  check("empty -> null", pickBestScheduleCandidate([], MON), null);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
