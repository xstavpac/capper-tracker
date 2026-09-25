// Proof that matchGameResult is safe to feed one shared, wide candidate pool
// (the M4a batching: gradePickPool / regradeFuzzyPool fetch GameResults once
// over the union of every pick's window, instead of one query per pick). The
// guarantee that makes that equivalent to the old per-pick query: given a
// pool spanning many days, each pick still only matches a GameResult inside
// its OWN +/-2d window and +/-6h drift - a wider pool never changes which
// game a pick grades against.
//
// Run with:
//   npx tsx src/server/data/grading-pool-match-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { matchGameResult } from "./grading";
import type { GameResult } from "@prisma/client";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const DAY = 86400000;
const g = (id: string, iso: string, home: string, away: string, gameNumber: number | null = null): GameResult =>
  ({
    id,
    sportKey: "baseball_mlb",
    externalId: id,
    homeTeam: home,
    awayTeam: away,
    homeScore: 0,
    awayScore: 0,
    gameDate: new Date(iso),
    gameNumber,
  }) as unknown as GameResult;

const pick = (iso: string, home: string, away: string, gameNumber: number | null = null) => ({
  gameTime: new Date(iso),
  homeTeam: home,
  awayTeam: away,
  betDetail: null as string | null,
  gameNumber,
});

// One shared pool covering a whole week of the same matchup on different days
// plus an unrelated game - exactly the shape gradePickPool builds.
const pool: GameResult[] = [
  g("mon", "2026-06-01T23:00:00Z", "Yankees", "Red Sox"),
  g("thu", "2026-06-04T23:00:00Z", "Yankees", "Red Sox"),
  g("sun", "2026-06-07T23:00:00Z", "Yankees", "Red Sox"),
  g("other", "2026-06-04T23:00:00Z", "Dodgers", "Padres"),
];

// A pick for Thursday's game matches Thursday's row, not Monday's or Sunday's,
// even though all three are in the pool.
expect(
  "wide pool: Thursday pick -> Thursday game",
  matchGameResult(pool, pick("2026-06-04T23:05:00Z", "Yankees", "Red Sox"))?.game.id,
  "thu"
);

// A pick whose game is 4 days from any pool row (outside the +/-2d window)
// matches nothing - the pool being wide doesn't let it latch onto a
// neighbouring day.
expect(
  "wide pool: pick 4 days off any row -> no match",
  matchGameResult(pool, pick("2026-06-12T23:00:00Z", "Yankees", "Red Sox")),
  null
);

// Same calendar day but >6h drift from the only same-teams row -> no match
// (the drift guard still applies against the pool).
expect(
  "wide pool: same day but >6h drift -> no match",
  matchGameResult(pool, pick("2026-06-04T06:00:00Z", "Yankees", "Red Sox")),
  null
);

// The unrelated game in the pool is never matched for this matchup.
expect(
  "wide pool: never matches a different matchup on the same day",
  matchGameResult(pool, pick("2026-06-04T23:00:00Z", "Yankees", "Red Sox"))?.game.id,
  "thu"
);

// ---------------------------------------------------------------------------
console.log("\n########## doubleheader: pick.gameNumber requires a GameResult gameNumber match ##########");
{
  // A type-Y (traditional) doubleheader: two real games 5 minutes apart -
  // well inside MAX_GAME_TIME_DRIFT_MS (6h), so without the gameNumber guard
  // the plain exact-match/closest-date tiebreak below would grade a Game 2
  // pick against Game 1's result (or vice versa) whenever they're closer to
  // each other than either is to the pick's own stamped gameTime.
  const dh = [
    g("g1", "2026-09-25T20:05:00Z", "New York Yankees", "Baltimore Orioles", 1),
    g("g2", "2026-09-25T20:10:00Z", "New York Yankees", "Baltimore Orioles", 2),
  ];

  expect(
    "Game 1 pick (gameTime stamped from g1) -> grades against g1, not the 5-min-closer g2",
    matchGameResult(dh, pick("2026-09-25T20:05:00Z", "New York Yankees", "Baltimore Orioles", 1))?.game.id,
    "g1"
  );
  expect(
    "Game 2 pick (gameTime stamped from g2) -> grades against g2, not g1",
    matchGameResult(dh, pick("2026-09-25T20:10:00Z", "New York Yankees", "Baltimore Orioles", 2))?.game.id,
    "g2"
  );
  // A pick's gameTime can drift slightly from its own game's real start (odds
  // snapshot timing, etc) - proves the gameNumber filter, not just gameTime
  // proximity, is what picks the right leg: this pick's OWN gameTime is
  // actually closer to g1, but gameNumber=2 must still win g2.
  expect(
    "gameNumber wins over closest-gameTime tiebreak",
    matchGameResult(dh, pick("2026-09-25T20:06:00Z", "New York Yankees", "Baltimore Orioles", 2))?.game.id,
    "g2"
  );

  // gameNumber set but no GameResult row carries a matching gameNumber (a row
  // from before this column existed) - never falls back to a closest-time
  // guess among the doubleheader legs; stays unmatched (PENDING).
  const dhNoMetadata = [
    g("g1", "2026-09-25T20:05:00Z", "New York Yankees", "Baltimore Orioles", null),
    g("g2", "2026-09-25T20:10:00Z", "New York Yankees", "Baltimore Orioles", null),
  ];
  expect(
    "gameNumber set, no GameResult carries it -> unmatched, not a time guess",
    matchGameResult(dhNoMetadata, pick("2026-09-25T20:10:00Z", "New York Yankees", "Baltimore Orioles", 2)),
    null
  );

  // A normal (non-doubleheader) pick with gameNumber null is completely
  // unaffected by GameResult rows that happen to carry a gameNumber.
  expect(
    "gameNumber null on the pick -> unaffected by GameResult.gameNumber, matches normally",
    matchGameResult(dh, pick("2026-09-25T20:05:00Z", "New York Yankees", "Baltimore Orioles", null))?.game.id,
    "g1"
  );
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
