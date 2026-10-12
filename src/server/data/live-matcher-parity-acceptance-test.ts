// The two matchScoreToGame copies must agree - run with:
//   npx tsx src/server/data/live-matcher-parity-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// There are two on purpose: server/data/odds.ts's (server components, the
// ticker) and components/live/live-scoreboard-ordering.ts's (client boards -
// odds.ts imports prisma and must never reach a client bundle). The server
// renders /live with one and the browser re-renders it with the other on the
// first score poll, so any disagreement shows up as a card that changes under
// the viewer. They did disagree until 2026-10: the client copy compared with
// ===, the server copy with teamNamesMatch, and a game whose teams the feeds
// spell differently had a score on the server and none on the client.
//
// Every name below is a real spelling: the score-feed side from ESPN / the MLB
// Stats API, the odds side from The Odds API (/participants), read 2026-10-12.

import { matchScoreToGame as serverMatch } from "./odds";
import type { ScoreGame } from "./odds";
import { matchScoreToGame as clientMatch } from "@/components/live/live-scoreboard-ordering";
import { CROSS_SOURCE_TEAM_ALIASES } from "@/lib/team-name-match";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const T1 = "2026-10-10T01:00:00Z";
const T2 = "2026-10-10T23:00:00Z";

let seq = 0;
const feedGame = (homeTeam: string, awayTeam: string, commenceTime = T1): ScoreGame => ({
  id: "feed-" + ++seq,
  homeTeam,
  awayTeam,
  status: "live",
  scores: null,
  commenceTime,
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
});

// One feed per league, score-feed spellings.
const FEEDS: Record<string, ScoreGame[]> = {
  americanfootball_ncaaf: [
    feedGame("San José State Spartans", "Wyoming Cowboys"),
    feedGame("Sam Houston Bearkats", "App State Mountaineers"),
    feedGame("Massachusetts Minutemen", "Southern Miss Golden Eagles"),
    feedGame("Louisiana Ragin' Cajuns", "Hawai'i Rainbow Warriors"),
    feedGame("Louisiana Tech Bulldogs", "UL Monroe Warhawks"),
    feedGame("Kentucky Wildcats", "LSU Tigers"),
  ],
  basketball_nba: [
    feedGame("LA Clippers", "Los Angeles Lakers"),
    feedGame("Boston Celtics", "New York Knicks"),
  ],
  icehockey_nhl: [
    feedGame("Montreal Canadiens", "St. Louis Blues"),
    feedGame("New York Rangers", "New York Islanders"),
  ],
  americanfootball_nfl: [feedGame("Seattle Seahawks", "Arizona Cardinals")],
  baseball_mlb: [
    // A doubleheader: same teams twice, told apart by start time.
    feedGame("St. Louis Cardinals", "Chicago Cubs", T1),
    feedGame("St. Louis Cardinals", "Chicago Cubs", T2),
  ],
};

type OddsGame = { homeTeam: string; awayTeam: string; commenceTime: string };
const g = (homeTeam: string, awayTeam: string, commenceTime = T1): OddsGame => ({ homeTeam, awayTeam, commenceTime });

// Odds API spellings. `expectMatch` is what BOTH copies must return when given the league.
const CASES: { sportKey: string; game: OddsGame; expectMatch: boolean; why: string }[] = [
  { sportKey: "americanfootball_ncaaf", game: g("San Jose State Spartans", "Wyoming Cowboys"), expectMatch: true, why: "accent fold" },
  { sportKey: "americanfootball_ncaaf", game: g("Sam Houston State Bearkats", "Appalachian State Mountaineers"), expectMatch: true, why: "two alias rows in one game" },
  { sportKey: "americanfootball_ncaaf", game: g("UMass Minutemen", "Southern Mississippi Golden Eagles"), expectMatch: true, why: "two alias rows in one game" },
  { sportKey: "americanfootball_ncaaf", game: g("Louisiana Ragin Cajuns", "Hawaii Rainbow Warriors"), expectMatch: true, why: "apostrophe aliases" },
  { sportKey: "americanfootball_ncaaf", game: g("Louisiana Tech Bulldogs", "UL Monroe Warhawks"), expectMatch: true, why: "exact" },
  { sportKey: "americanfootball_ncaaf", game: g("Kentucky Wildcats", "LSU Tigers"), expectMatch: true, why: "exact" },
  { sportKey: "americanfootball_ncaaf", game: g("LSU Tigers", "Kentucky Wildcats"), expectMatch: false, why: "home/away swapped" },
  { sportKey: "americanfootball_ncaaf", game: g("Louisiana Tech Bulldogs", "Hawaii Rainbow Warriors"), expectMatch: false, why: "Louisiana Tech is not Louisiana" },
  { sportKey: "americanfootball_ncaaf", game: g("UL Monroe Warhawks", "Hawaii Rainbow Warriors"), expectMatch: false, why: "UL Monroe is not Louisiana" },
  { sportKey: "basketball_nba", game: g("Los Angeles Clippers", "Los Angeles Lakers"), expectMatch: true, why: "Clippers alias" },
  { sportKey: "basketball_nba", game: g("Los Angeles Lakers", "Los Angeles Clippers"), expectMatch: false, why: "home/away swapped" },
  { sportKey: "basketball_nba", game: g("Boston Celtics", "New York Knicks"), expectMatch: true, why: "exact" },
  { sportKey: "icehockey_nhl", game: g("Montréal Canadiens", "St Louis Blues"), expectMatch: true, why: "accent + period fold" },
  { sportKey: "icehockey_nhl", game: g("New York Rangers", "New York Islanders"), expectMatch: true, why: "exact" },
  { sportKey: "icehockey_nhl", game: g("New York Islanders", "New York Rangers"), expectMatch: false, why: "home/away swapped" },
  { sportKey: "americanfootball_nfl", game: g("Seattle Seahawks", "Arizona Cardinals"), expectMatch: true, why: "exact" },
  { sportKey: "baseball_mlb", game: g("St. Louis Cardinals", "Chicago Cubs", T1), expectMatch: true, why: "doubleheader game 1" },
  { sportKey: "baseball_mlb", game: g("St. Louis Cardinals", "Chicago Cubs", T2), expectMatch: true, why: "doubleheader game 2" },
];

console.log("\n########## with the league key (how every /live caller calls them) ##########");
for (const { sportKey, game, expectMatch, why } of CASES) {
  const label = `${sportKey}: ${game.awayTeam} @ ${game.homeTeam} (${why})`;
  const s = serverMatch(FEEDS[sportKey], game, sportKey);
  const c = clientMatch(FEEDS[sportKey], game, sportKey);
  check(`${label}: client and server pick the same score`, c?.id ?? null, s?.id ?? null);
  check(`${label}: ${expectMatch ? "matched" : "no match"}`, s !== undefined, expectMatch);
}

{
  const feed = FEEDS.baseball_mlb;
  const g1 = clientMatch(feed, g("St. Louis Cardinals", "Chicago Cubs", T1), "baseball_mlb");
  const g2 = clientMatch(feed, g("St. Louis Cardinals", "Chicago Cubs", T2), "baseball_mlb");
  check("doubleheader: the two odds games resolve to two different scores", g1?.id !== g2?.id && !!g1 && !!g2, true);
}

console.log("\n########## without a league key, and under the wrong one ##########");
for (const { sportKey, game } of CASES) {
  for (const key of [undefined, "icehockey_nhl", "americanfootball_ncaaf"]) {
    const s = serverMatch(FEEDS[sportKey], game, key);
    const c = clientMatch(FEEDS[sportKey], game, key);
    check(`${sportKey} feed, key=${key ?? "none"}: ${game.awayTeam} @ ${game.homeTeam} - same answer from both`, c?.id ?? null, s?.id ?? null);
  }
}

console.log("\n########## every alias row, each direction ##########");
for (const [sportKey, rows] of Object.entries(CROSS_SOURCE_TEAM_ALIASES)) {
  for (const [scoreFeed, oddsApi] of rows) {
    const feed = [feedGame(scoreFeed, "Opponent A"), feedGame("Opponent B", scoreFeed)];
    for (const game of [g(oddsApi, "Opponent A"), g("Opponent B", oddsApi)]) {
      const s = serverMatch(feed, game, sportKey);
      const c = clientMatch(feed, game, sportKey);
      check(`${sportKey}: "${oddsApi}" finds "${scoreFeed}" (${game.homeTeam === oddsApi ? "home" : "away"}) on both`, [c?.id ?? null, s !== undefined], [s?.id ?? null, true]);
    }
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
