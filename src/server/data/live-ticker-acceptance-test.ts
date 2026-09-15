// Proof for buildTickerGamesForSport / interleaveByCommenceTime
// (live-ticker.ts) - the pure transform behind getLiveTickerGames, split out
// specifically so it's testable without a DB/network (getLiveTickerGames
// itself calls getOddsForSport/getLiveScoresForSport, which aren't pure).
// Covers today's-Eastern-date filtering and cross-sport interleaving - see
// T1 (ticker caching fix). Run with:
//   npx tsx src/server/data/live-ticker-acceptance-test.ts
import { buildTickerGamesForSport, interleaveByCommenceTime, type TickerGame } from "./live-ticker";
import type { OddsGame, ScoreGame } from "./odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// Fixed reference instant - 2026-09-15 14:00 Eastern (18:00 UTC, EDT) - so
// this test never depends on when it's actually run.
const NOW = new Date("2026-09-15T18:00:00Z");

function odds(id: string, commenceTime: string, home = "Home Team", away = "Away Team"): OddsGame {
  return { id, sportKey: "baseball_mlb", homeTeam: home, awayTeam: away, commenceTime, bookmakers: [] };
}

function score(homeTeam: string, awayTeam: string, commenceTime: string, status: ScoreGame["status"], home: string, away: string): ScoreGame {
  return {
    id: "s-" + homeTeam,
    homeTeam,
    awayTeam,
    status,
    scores: [
      { name: homeTeam, score: home },
      { name: awayTeam, score: away },
    ],
    commenceTime,
    inningHalf: null,
    inningOrdinal: null,
    innings: null,
  };
}

// --- today's-Eastern-date filtering ---
{
  const todayEarly = odds("g-today-early", "2026-09-15T17:00:00Z"); // 1pm ET, already started
  const todayLater = odds("g-today-later", "2026-09-15T23:00:00Z"); // 7pm ET, not started yet - still "today, full stop"
  const yesterday = odds("g-yesterday", "2026-09-14T20:00:00Z");
  const tomorrow = odds("g-tomorrow", "2026-09-16T17:00:00Z");

  const result = buildTickerGamesForSport(
    "baseball_mlb",
    "MLB",
    [todayEarly, todayLater, yesterday, tomorrow],
    [],
    NOW
  );

  check(
    "keeps only today's Eastern-date games (both started and not-yet-started), excludes yesterday/tomorrow",
    result.map((g) => g.id).sort(),
    ["g-today-early", "g-today-later"]
  );
}

// --- score matching / fallback ---
{
  const game = odds("g1", "2026-09-15T17:00:00Z", "Yankees", "Red Sox");
  const withScore = buildTickerGamesForSport(
    "baseball_mlb",
    "MLB",
    [game],
    [score("Yankees", "Red Sox", "2026-09-15T17:00:00Z", "live", "3", "2")],
    NOW
  );
  check("matched game carries the live score", withScore[0]?.homeScore, 3);
  check("matched game carries live status", withScore[0]?.status, "live");

  const withoutScore = buildTickerGamesForSport("baseball_mlb", "MLB", [game], [], NOW);
  check("no score match falls back to preview status", withoutScore[0]?.status, "preview");
  check("no score match has null scores", [withoutScore[0]?.homeScore, withoutScore[0]?.awayScore], [null, null]);
}

// --- cross-sport interleaving ---
{
  const mlb: TickerGame[] = buildTickerGamesForSport(
    "baseball_mlb",
    "MLB",
    [odds("mlb-1", "2026-09-15T23:00:00Z"), odds("mlb-2", "2026-09-15T17:00:00Z")],
    [],
    NOW
  );
  const nfl: TickerGame[] = buildTickerGamesForSport(
    "americanfootball_nfl",
    "NFL",
    [odds("nfl-1", "2026-09-15T20:00:00Z")],
    [],
    NOW
  );

  const interleaved = interleaveByCommenceTime([mlb, nfl]);
  check(
    "interleaves every sport's games by commenceTime, not grouped by sport",
    interleaved.map((g) => g.id),
    ["mlb-2", "nfl-1", "mlb-1"]
  );
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
