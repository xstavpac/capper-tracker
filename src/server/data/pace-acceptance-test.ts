// Proof for pace.ts - the shared half of the Pace engine (point-in-time
// baseline math, eligibility, and the ratio -> classification pipeline).
// No database: everything here is fed synthetic fixtures, matching
// mlb-momentum-acceptance-test.ts's pure/no-DB pattern.
// Run: npx tsx src/server/data/pace-acceptance-test.ts

import {
  computeTeamBaseline,
  isPaceEligible,
  classifyPaceRatio,
  paceRatio,
  buildPaceTrend,
  type BaselineGameRow,
} from "./pace";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

function row(homeTeam: string, awayTeam: string, homeScore: number, awayScore: number, dateIso: string): BaselineGameRow {
  return { homeTeam, awayTeam, homeScore, awayScore, gameDate: new Date(dateIso) };
}

const SEASON_START = new Date("2026-03-15T00:00:00.000Z");
// The "current game's" own cutoff - its Eastern day start. Nothing dated on
// or after this may ever enter a baseline.
const CURRENT_GAME_CUTOFF = new Date("2026-06-10T00:00:00.000Z");

// ---- computeTeamBaseline: rolling average calculation ----
{
  const games = [
    row("Cubs", "Brewers", 4, 2, "2026-06-01T00:00:00.000Z"), // Cubs 4
    row("Reds", "Cubs", 3, 6, "2026-06-05T00:00:00.000Z"), // Cubs 6 (away)
    row("Cubs", "Pirates", 2, 1, "2026-06-08T00:00:00.000Z"), // Cubs 2
  ];
  const baseline = computeTeamBaseline(games, "Cubs", { seasonStart: SEASON_START, before: CURRENT_GAME_CUTOFF });
  check("rolling average considers every prior completed game for the team", baseline.gamesConsidered === 3);
  check(
    "rolling average is the team's OWN score in each game (home or away), not the opponent's",
    baseline.avgPerGame === (4 + 6 + 2) / 3,
    `avgPerGame=${baseline.avgPerGame}`
  );
}

// ---- Zero-sample states: both the 0/0 and 1/0 cases ----
{
  const noGames: BaselineGameRow[] = [];
  const zeroBaseline = computeTeamBaseline(noGames, "Cubs", { seasonStart: SEASON_START, before: CURRENT_GAME_CUTOFF });
  check("zero prior games -> gamesConsidered 0", zeroBaseline.gamesConsidered === 0);
  check("zero prior games -> avgPerGame null, not 0 or fabricated", zeroBaseline.avgPerGame === null);

  // Each team is queried independently in production (seasonGamesForTeam is
  // called once per team - see mlb-pace-data.ts/nfl-pace-data.ts), so the
  // 1/0 fixture models that honestly: Cubs' own query returned one prior
  // game, Brewers' own query returned none - NOT the two sides of the same
  // shared game row (which would give both teams a game and never exercise
  // 1/0 at all).
  const cubsOneGame = [row("Cubs", "Pirates", 5, 3, "2026-06-01T00:00:00.000Z")];
  const homeBaseline = computeTeamBaseline(cubsOneGame, "Cubs", { seasonStart: SEASON_START, before: CURRENT_GAME_CUTOFF });
  const brewersNoGames = computeTeamBaseline([], "Brewers", { seasonStart: SEASON_START, before: CURRENT_GAME_CUTOFF });
  check("the 1/0 case: one team has a real baseline...", homeBaseline.gamesConsidered === 1 && homeBaseline.avgPerGame === 5);
  check("...the other genuinely has zero...", brewersNoGames.gamesConsidered === 0);
  check(
    "...but 1/0 must still fail eligibility overall - one side's data can't stand in for the whole game",
    !isPaceEligible(homeBaseline, brewersNoGames)
  );
}

// ---- isPaceEligible: exact transition point ----
{
  const zero = { teamName: "A", avgPerGame: null, gamesConsidered: 0 };
  const zeroOther = { teamName: "B", avgPerGame: null, gamesConsidered: 0 };
  check("0 prior games each -> not eligible", !isPaceEligible(zero, zeroOther));

  const one = { teamName: "A", avgPerGame: 4.5, gamesConsidered: 1 };
  const oneOther = { teamName: "B", avgPerGame: 3.2, gamesConsidered: 1 };
  check("1 prior game each -> eligible (the exact transition)", isPaceEligible(one, oneOther));

  check("1 game for A but 0 for B -> still not eligible", !isPaceEligible(one, zeroOther));
}

// ---- Point-in-time correctness ----
{
  const games = [
    row("Cubs", "Brewers", 4, 2, "2026-06-09T23:59:59.000Z"), // just before cutoff - included
    row("Cubs", "Pirates", 9, 1, "2026-06-10T00:00:00.000Z"), // exactly at cutoff - excluded (strict <)
    row("Cubs", "Reds", 8, 0, "2026-06-15T00:00:00.000Z"), // after cutoff - excluded
  ];
  const baseline = computeTeamBaseline(games, "Cubs", { seasonStart: SEASON_START, before: CURRENT_GAME_CUTOFF });
  check("a game strictly before the cutoff is included", baseline.gamesConsidered === 1);
  check("a game AT or AFTER the cutoff is excluded, never included", baseline.avgPerGame === 4);

  const beforeSeason = [row("Cubs", "Brewers", 99, 0, "2025-09-01T00:00:00.000Z")]; // last season
  const seasonScoped = computeTeamBaseline(beforeSeason, "Cubs", { seasonStart: SEASON_START, before: CURRENT_GAME_CUTOFF });
  check("a game from a PRIOR season is excluded even though it's before the cutoff", seasonScoped.gamesConsidered === 0);
}

// ---- Current-game contamination: the deliberately huge current-game score must never leak in ----
{
  const priorGames = [
    row("Cubs", "Brewers", 3, 2, "2026-06-01T00:00:00.000Z"),
    row("Reds", "Cubs", 2, 5, "2026-06-05T00:00:00.000Z"),
  ];
  const contaminatedCurrentGameRow = row("Cubs", "Pirates", 47, 1, "2026-06-10T08:00:00.000Z"); // "today", huge score
  const withContamination = [...priorGames, contaminatedCurrentGameRow];

  const clean = computeTeamBaseline(priorGames, "Cubs", { seasonStart: SEASON_START, before: CURRENT_GAME_CUTOFF });
  const withCurrentGameInFixtures = computeTeamBaseline(withContamination, "Cubs", {
    seasonStart: SEASON_START,
    before: CURRENT_GAME_CUTOFF,
  });
  check(
    "the current game's huge score never enters the baseline, even when the row is present in the fixture set",
    clean.avgPerGame === withCurrentGameInFixtures.avgPerGame && clean.gamesConsidered === withCurrentGameInFixtures.gamesConsidered,
    `clean=${clean.avgPerGame} (${clean.gamesConsidered}g) vs withCurrentGameInFixtures=${withCurrentGameInFixtures.avgPerGame} (${withCurrentGameInFixtures.gamesConsidered}g)`
  );
  check("sanity: the contaminated row really was huge enough to swing an average if it leaked", contaminatedCurrentGameRow.homeScore === 47);
}

// ---- classifyPaceRatio: the shared 5-bucket shape ----
{
  const thresholds = { muchSlower: 0.5, slower: 0.75, faster: 1.35, muchFaster: 1.75 };
  check("ratio well below muchSlower -> MUCH_SLOWER", classifyPaceRatio(0.2, thresholds) === "MUCH_SLOWER");
  check("ratio exactly at muchSlower boundary -> MUCH_SLOWER (inclusive)", classifyPaceRatio(0.5, thresholds) === "MUCH_SLOWER");
  check("ratio between muchSlower and slower -> SLOWER", classifyPaceRatio(0.6, thresholds) === "SLOWER");
  check("ratio near 1.0 -> NEAR_EXPECTED", classifyPaceRatio(1.0, thresholds) === "NEAR_EXPECTED");
  check("ratio between faster and muchFaster -> FASTER", classifyPaceRatio(1.5, thresholds) === "FASTER");
  check("ratio at or above muchFaster -> MUCH_FASTER", classifyPaceRatio(1.75, thresholds) === "MUCH_FASTER");
  check("an extreme ratio (early-game blowout) still classifies, never throws", classifyPaceRatio(50, thresholds) === "MUCH_FASTER");
}

// ---- paceRatio: divide-by-zero guardrails ----
{
  check("0 actual / 0 expected reads as exactly on pace (1), not NaN", paceRatio(0, 0) === 1);
  check("positive actual / 0 expected reads as +Infinity, not NaN", paceRatio(5, 0) === Number.POSITIVE_INFINITY);
  check("a normal ratio divides as expected", paceRatio(6, 4) === 1.5);
}

// ---- buildPaceTrend: the readyForRead gate ----
{
  const thresholds = { muchSlower: 0.5, slower: 0.75, faster: 1.35, muchFaster: 1.75 };
  const tooEarly = buildPaceTrend({ actualTotal: 4, expectedTotal: 0.2, fractionComplete: 0.02, minFractionForRead: 0.11, thresholds });
  check("below the minimum fraction, readyForRead is false regardless of the ratio", !tooEarly.readyForRead);
  check("below the minimum fraction, classification defaults to NEAR_EXPECTED (never a fabricated extreme read)", tooEarly.classification === "NEAR_EXPECTED");

  const ready = buildPaceTrend({ actualTotal: 10, expectedTotal: 5, fractionComplete: 0.5, minFractionForRead: 0.11, thresholds });
  check("at or above the minimum fraction, readyForRead is true", ready.readyForRead);
  check("at or above the minimum fraction, classification reflects the real ratio", ready.classification === "MUCH_FASTER");
}

console.log("\n" + "=".repeat(60));
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
