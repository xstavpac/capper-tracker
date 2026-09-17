// Proof for resolvePropOddsFromGame's two combined-category markets
// (RUSH_REC_YDS -> player_rush_reception_yds, PASS_RUSH_YDS ->
// player_pass_rush_yds - nfl-prop-odds.ts), run with:
//   npx tsx src/server/data/nfl-combined-prop-odds-resolution-acceptance-test.ts
//
// Companion to player-prop-odds-resolution-acceptance-test.ts (the original
// single-category-market PR) - uses a separate real, live-captured fixture
// (__fixtures__/odds-api-event-combined-props-response.json - Detroit Lions
// @ Buffalo Bills, captured live 2026-09-17, see nfl-prop-odds.ts's header
// for the exact verification: x-requests-remaining dropped 19395 -> 19392).
//
// Pure - no network, no database. Run with:
//   npx tsx src/server/data/nfl-combined-prop-odds-resolution-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePropOddsFromGame } from "@/server/data/nfl-prop-odds";
import type { OddsGame } from "@/server/data/odds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
function ok(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

const FIX = join(__dirname, "__fixtures__");
function loadFixture(name: string): OddsGame {
  const raw = JSON.parse(readFileSync(join(FIX, name), "utf8"));
  return {
    id: raw.id,
    sportKey: raw.sport_key,
    homeTeam: raw.home_team,
    awayTeam: raw.away_team,
    commenceTime: raw.commence_time,
    bookmakers: raw.bookmakers,
  };
}

function main() {
  const game = loadFixture("odds-api-event-combined-props-response.json");
  expect("fixture: home/away teams", { home: game.homeTeam, away: game.awayTeam }, {
    home: "Buffalo Bills",
    away: "Detroit Lions",
  });

  // =====================================================================
  // 1. RUSH_REC_YDS - draftkings is listed first among the 4 books that
  //    offer Jahmyr Gibbs at this exact 124.5 point (fanduel/betmgm/
  //    betrivers all have him at a different point, 123.5) - proves the
  //    exact-point match, not just "player+market found somewhere".
  // =====================================================================
  expect(
    "Jahmyr Gibbs Over 124.5 Rush + Rec Yards -> draftkings' -112 (the one book at this exact point)",
    resolvePropOddsFromGame(game, { playerName: "Jahmyr Gibbs", propMarket: "RUSH_REC_YDS", side: "Over", point: 124.5 }),
    -112
  );
  expect(
    "Jahmyr Gibbs Over 123.5 Rush + Rec Yards -> fanduel's -113 (first bookmaker at the OTHER real point, 123.5)",
    resolvePropOddsFromGame(game, { playerName: "Jahmyr Gibbs", propMarket: "RUSH_REC_YDS", side: "Over", point: 123.5 }),
    -113
  );

  // Second player, same market, confirms this isn't a single-outcome fluke.
  expect(
    "James Cook Under 102.5 Rush + Rec Yards -> draftkings' -111",
    resolvePropOddsFromGame(game, { playerName: "James Cook", propMarket: "RUSH_REC_YDS", side: "Under", point: 102.5 }),
    -111
  );

  // =====================================================================
  // 2. PASS_RUSH_YDS - Josh Allen, confirms the QB combined market maps to
  //    player_pass_rush_yds, not confused with the plain PASS_YDS market
  //    (this fixture has no player_pass_yds entries at all).
  // =====================================================================
  expect(
    "Josh Allen Over 291.5 Passing + Rushing Yards -> draftkings' -112 (the one book at this exact point)",
    resolvePropOddsFromGame(game, { playerName: "Josh Allen", propMarket: "PASS_RUSH_YDS", side: "Over", point: 291.5 }),
    -112
  );
  expect(
    "Josh Allen Under 290.5 Passing + Rushing Yards -> betmgm's -115 (first bookmaker at the OTHER real point, 290.5)",
    resolvePropOddsFromGame(game, { playerName: "Josh Allen", propMarket: "PASS_RUSH_YDS", side: "Under", point: 290.5 }),
    -115
  );

  // =====================================================================
  // 3. Fallback-to-null cases - market/point/player combinations this
  //    fixture genuinely does not carry.
  // =====================================================================
  ok(
    "RUSH_REC_YDS at a point no book offers -> null, never guessed",
    resolvePropOddsFromGame(game, { playerName: "Jahmyr Gibbs", propMarket: "RUSH_REC_YDS", side: "Over", point: 999.5 }) === null
  );
  ok(
    "PASS_RUSH_YDS for a player this fixture never lists -> null",
    resolvePropOddsFromGame(game, { playerName: "Nobody Realname", propMarket: "PASS_RUSH_YDS", side: "Over", point: 100.5 }) === null
  );
  ok(
    "Josh Allen under the single-category RUSH_YDS market -> null (this fixture has no player_rush_yds entries, only the combined market)",
    resolvePropOddsFromGame(game, { playerName: "Josh Allen", propMarket: "RUSH_YDS", side: "Over", point: 20.5 }) === null
  );

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
