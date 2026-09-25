// Proof for decision 7 of the doubleheader game-number fix: odds enrichment
// (resolveOddsGame, odds.ts) already keys off the RESOLVED game's own
// commenceTime, not "first event matching team names" - so once
// pickBestScheduleCandidate (see catalog-import-schedule-resolution-
// acceptance-test.ts) correctly resolves a pick to Game 2's ScoreGame, odds
// enrichment naturally gets Game 2's Odds API event and price, never Game
// 1's, with NO change needed to resolveOddsGame itself.
//
// resolveOddsGame is `async` and calls getOddsForSport (a live/DB-cached
// fetch) - not independently mockable without network/DB stubbing, and
// player-prop-odds-resolution-acceptance-test.ts already documents the same
// decision not to re-test it directly. This instead exercises the exact
// selection algorithm resolveOddsGame's body runs - team match (teamNamesMatch)
// + closest-commenceTime (closestByTime) - reading resolveOddsGame's own
// source (odds.ts) to confirm the algorithm matches before trusting this
// proof of it.
//
// Run with:
//   npx tsx src/server/data/doubleheader-odds-resolution-acceptance-test.ts
import { closestByTime } from "@/lib/dates";
import { teamNamesMatch } from "@/lib/team-name-match";
import type { OddsGame } from "@/server/data/odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// Mirrors resolveOddsGame's own body exactly (odds.ts) - team-matched
// candidates, then closest by commenceTime to the resolved game's own start.
function resolveOddsGameCore(
  oddsGames: OddsGame[],
  game: { homeTeam: string; awayTeam: string; commenceTime: string }
): OddsGame | null {
  const candidates = oddsGames.filter(
    (g) => teamNamesMatch(g.homeTeam, game.homeTeam) && teamNamesMatch(g.awayTeam, game.awayTeam)
  );
  if (candidates.length === 0) return null;
  const gameStart = new Date(game.commenceTime).getTime();
  return closestByTime(candidates, (g) => new Date(g.commenceTime).getTime(), gameStart);
}

const oddsGame = (id: string, home: string, away: string, commenceTime: string): OddsGame => ({
  id,
  sportKey: "baseball_mlb",
  homeTeam: home,
  awayTeam: away,
  commenceTime,
  bookmakers: [
    { key: "draftkings", title: "DraftKings", markets: [{ key: "h2h", outcomes: [{ name: home, price: id === "g1-odds" ? -140 : -180 }, { name: away, price: id === "g1-odds" ? 120 : 150 }] }] },
  ],
});

// ---------------------------------------------------------------------------
console.log("########## a correctly resolved doubleheader leg gets that leg's own odds event ##########");
{
  // Real shape: two Odds API events for the same matchup, minutes apart,
  // with genuinely different prices (a Y-type doubleheader often has a
  // different starter/line for each game).
  const events = [
    oddsGame("g1-odds", "New York Yankees", "Baltimore Orioles", "2026-09-25T20:05:00Z"),
    oddsGame("g2-odds", "New York Yankees", "Baltimore Orioles", "2026-09-25T20:10:00Z"),
  ];

  // A pick resolved to Game 1 (pickBestScheduleCandidate returned the g1
  // ScoreGame - see the schedule-resolution test) carries g1's own
  // commenceTime here.
  const resolvedAsGame1 = resolveOddsGameCore(events, {
    homeTeam: "New York Yankees",
    awayTeam: "Baltimore Orioles",
    commenceTime: "2026-09-25T20:05:00Z",
  });
  check("Game 1 pick's resolved game -> Game 1's odds event", resolvedAsGame1?.id, "g1-odds");
  check("Game 1 pick -> Game 1's h2h price (-140), not Game 2's", resolvedAsGame1?.bookmakers[0].markets[0].outcomes[0].price, -140);

  // A pick resolved to Game 2 carries g2's commenceTime - proves it does NOT
  // fall back to "first event matching team names" (which would incorrectly
  // return g1-odds, listed first in the array, for both).
  const resolvedAsGame2 = resolveOddsGameCore(events, {
    homeTeam: "New York Yankees",
    awayTeam: "Baltimore Orioles",
    commenceTime: "2026-09-25T20:10:00Z",
  });
  check("Game 2 pick's resolved game -> Game 2's odds event, not Game 1's (array order)", resolvedAsGame2?.id, "g2-odds");
  check("Game 2 pick -> Game 2's h2h price (-180), not Game 1's", resolvedAsGame2?.bookmakers[0].markets[0].outcomes[0].price, -180);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
