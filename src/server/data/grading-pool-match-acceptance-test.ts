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
const g = (id: string, iso: string, home: string, away: string): GameResult =>
  ({
    id,
    sportKey: "baseball_mlb",
    externalId: id,
    homeTeam: home,
    awayTeam: away,
    homeScore: 0,
    awayScore: 0,
    gameDate: new Date(iso),
  }) as unknown as GameResult;

const pick = (iso: string, home: string, away: string) => ({
  gameTime: new Date(iso),
  homeTeam: home,
  awayTeam: away,
  betDetail: null as string | null,
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

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
