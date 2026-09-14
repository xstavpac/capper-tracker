// Proof for the live-odds enrichment added to bulk-imported PLAYER_PROP
// picks: resolvePropOddsFromGame/resolvePropOdds (nfl-prop-odds.ts),
// parsePlayerPropLine (bet-line.ts), and stripTeamNamesFromPlayerName
// (parse-catalog.ts), plus the end-to-end pipeline resolveGameAndOdds
// (bulk-picks.ts) now runs for a no-explicit-odds PLAYER_PROP pick.
//
// Uses the SAME real, live-captured fixture nfl-prop-odds-acceptance-test.ts
// already proves normalizePlayerPropLines against
// (__fixtures__/odds-api-event-rush-rec-response.json - Chiefs @ Broncos,
// captured live 2026-09-14, see nfl-prop-odds.ts's header for provenance),
// so the "first bookmaker wins" and "exact point match" assertions below are
// checked against real observed bookmaker prices, not synthetic ones.
//
// Pure - no network, no database (resolvePropOdds's DB-resolving half,
// resolveOddsGame, is exactly the same helper findMarketPrice already uses
// and isn't separately re-tested here). Run with:
//   npx tsx src/server/data/player-prop-odds-resolution-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePropOddsFromGame } from "@/server/data/nfl-prop-odds";
import type { OddsGame } from "@/server/data/odds";
import { parsePlayerPropLine, parsePlayerProp } from "@/lib/bet-line";
import { stripTeamNamesFromPlayerName } from "@/lib/parse-catalog";

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

async function main() {
  const game = loadFixture("odds-api-event-rush-rec-response.json");
  // Sanity on the fixture itself - if this ever drifts, every assertion
  // below needs re-deriving against the new numbers, not silently updating.
  expect("fixture: home/away teams", { home: game.homeTeam, away: game.awayTeam }, {
    home: "Kansas City Chiefs",
    away: "Denver Broncos",
  });

  // =====================================================================
  // 1. resolvePropOddsFromGame - first-bookmaker-wins policy against REAL
  //    multi-bookmaker data. draftkings (-110) is listed before fanduel
  //    (-113), betonlineag (-114), and bovada (also offers 42.5 among its
  //    several alternate lines, at -115) for this exact Travis Kelce Over
  //    42.5 Receiving Yards line - confirming this isn't a "only one book
  //    has it" false positive.
  // =====================================================================
  expect(
    "Travis Kelce Over 42.5 Receiving Yards -> draftkings' -110 (first bookmaker), not fanduel/-onlineag/bovada's later prices",
    resolvePropOddsFromGame(game, { playerName: "Travis Kelce", propMarket: "REC_YDS", side: "Over", point: 42.5 }),
    -110
  );

  // =====================================================================
  // 2. A QB rushing-yards line (player_rush_yds) - confirms RUSH_YDS maps
  //    correctly and isn't confused with REC_YDS/RECEPTIONS for the same
  //    kind of "yards" market.
  // =====================================================================
  expect(
    "Patrick Mahomes Over 15.5 Rushing Yards -> draftkings' -106 (first bookmaker with this exact point)",
    resolvePropOddsFromGame(game, { playerName: "Patrick Mahomes", propMarket: "RUSH_YDS", side: "Over", point: 15.5 }),
    -106
  );

  // =====================================================================
  // 3. RECEPTIONS market + Under side - confirms side and market are both
  //    matched, not just point/player.
  // =====================================================================
  expect(
    "Travis Kelce Under 4.5 Receptions -> draftkings' -160",
    resolvePropOddsFromGame(game, { playerName: "Travis Kelce", propMarket: "RECEPTIONS", side: "Under", point: 4.5 }),
    -160
  );

  // =====================================================================
  // 4. Fuzzy player-name matching (isLikelyDuplicateName, fuzzy-match.ts) -
  //    a capper's typo'd spelling still resolves to the real line.
  // =====================================================================
  expect(
    "typo'd 'Travis Kelcee' still fuzzy-matches the real 'Travis Kelce' line",
    resolvePropOddsFromGame(game, { playerName: "Travis Kelcee", propMarket: "REC_YDS", side: "Over", point: 42.5 }),
    -110
  );

  // =====================================================================
  // 5. Fallback-to-null cases - each must return null (never throw, never
  //    guess a nearby price), so callers correctly keep the -110 default.
  // =====================================================================
  ok(
    "line doesn't match exactly (Kelce Over 99.5, no book offers that point) -> null",
    resolvePropOddsFromGame(game, { playerName: "Travis Kelce", propMarket: "REC_YDS", side: "Over", point: 99.5 }) === null
  );
  ok(
    "player not in the snapshot -> null",
    resolvePropOddsFromGame(game, { playerName: "Nobody Realname", propMarket: "REC_YDS", side: "Over", point: 42.5 }) === null
  );
  ok(
    "market not offered in this snapshot (PASS_YDS - this fixture is rush/receiving/receptions only) -> null",
    resolvePropOddsFromGame(game, { playerName: "Patrick Mahomes", propMarket: "PASS_YDS", side: "Over", point: 275.5 }) === null
  );
  ok(
    "TD has no Over/Under+point concept (one-sided 'Yes' market, see nfl-prop-odds.ts) -> null, never guessed",
    resolvePropOddsFromGame(game, { playerName: "Travis Kelce", propMarket: "TD", side: "Over", point: 0.5 }) === null
  );

  // =====================================================================
  // 6. parsePlayerPropLine (bet-line.ts) - realistic capper pick text, same
  //    style as player-prop-parsing-acceptance-test.ts's parsePlayerProp
  //    fixtures. Shared with grading.ts's resolveYardageOrReceptionsProp.
  // =====================================================================
  expect(
    "parsePlayerPropLine: 'Bills Josh Allen Over 275.5 Passing Yards'",
    parsePlayerPropLine("Bills Josh Allen Over 275.5 Passing Yards"),
    { direction: "OVER", line: 275.5 }
  );
  expect(
    "parsePlayerPropLine: 'Bills Bijan Robinson Under 65.5 Rushing Yards'",
    parsePlayerPropLine("Bills Bijan Robinson Under 65.5 Rushing Yards"),
    { direction: "UNDER", line: 65.5 }
  );
  expect(
    "parsePlayerPropLine: o/u shorthand 'Justin Jefferson O5.5 Receptions'",
    parsePlayerPropLine("Justin Jefferson O5.5 Receptions"),
    { direction: "OVER", line: 5.5 }
  );
  expect("parsePlayerPropLine: TD prop text has no Over/Under -> null", parsePlayerPropLine("Puka Nacua Anytime TD"), null);
  expect(
    "parsePlayerPropLine: text naming both sides (each with its own number) is ambiguous -> null",
    parsePlayerPropLine("Josh Allen Over 275.5 or Under 265.5 Passing Yards"),
    null
  );

  // =====================================================================
  // 7. End-to-end pipeline: exactly what resolveGameAndOdds (bulk-picks.ts)
  //    now runs for a no-explicit-odds PLAYER_PROP pick - parsePlayerProp,
  //    strip the capper's team-nickname prefix (needed for game resolution,
  //    left in place by parsePlayerProp itself), parsePlayerPropLine, then
  //    resolvePropOddsFromGame. Real fixture data end to end.
  // =====================================================================
  const pickText = "Chiefs Travis Kelce Over 42.5 Receiving Yards";
  const parsedProp = parsePlayerProp(pickText)!;
  expect("pipeline: parsePlayerProp leaves the team prefix in playerName", parsedProp, {
    playerName: "Chiefs Travis Kelce",
    propMarket: "REC_YDS",
  });
  const strippedName = stripTeamNamesFromPlayerName(parsedProp.playerName, [game.homeTeam, game.awayTeam], "NFL");
  expect("pipeline: stripTeamNamesFromPlayerName removes the 'Chiefs' prefix", strippedName, "Travis Kelce");
  const parsedLine = parsePlayerPropLine(pickText)!;
  const pipelinePrice = resolvePropOddsFromGame(game, {
    playerName: strippedName,
    propMarket: parsedProp.propMarket,
    side: parsedLine.direction === "OVER" ? "Over" : "Under",
    point: parsedLine.line,
  });
  expect("pipeline: 'Chiefs Travis Kelce Over 42.5 Receiving Yards' with no explicit odds resolves to draftkings' real -110", pipelinePrice, -110);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
