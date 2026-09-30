// Proof for import-time Anytime TD pricing: resolveAnytimeTdOddsFromGame /
// resolvePropOddsFromGame("TD") against the REAL live-captured
// player_anytime_td response (__fixtures__/odds-api-event-anytime-td-response.json,
// Chiefs vs Broncos, captured 2026-09-14 - see nfl-prop-odds.ts's header), plus
// the exact pick-text gating bulk-picks.ts's resolveGameAndOdds applies
// (isAnytimeTdPick) and proof that TD parsing - what grading reads - is
// unchanged. Pure, no network/DB. Run with:
//   npx tsx src/server/data/anytime-td-odds-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePropOddsFromGame, normalizePlayerPropLines } from "@/server/data/nfl-prop-odds";
import type { OddsGame } from "@/server/data/odds";
import { parsePlayerProp, parseTouchdownProp, isAnytimeTdPick } from "@/lib/bet-line";
import { stripTeamNamesFromPlayerName } from "@/lib/parse-catalog";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const raw = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "odds-api-event-anytime-td-response.json"), "utf8"));
const game: OddsGame = {
  id: raw.id,
  sportKey: raw.sport_key,
  homeTeam: raw.home_team,
  awayTeam: raw.away_team,
  commenceTime: raw.commence_time,
  bookmakers: raw.bookmakers,
};

// What resolveGameAndOdds does for a no-explicit-odds PLAYER_PROP pick, minus
// the cache read (resolvePropOdds = resolveOddsGame + resolvePropOddsFromGame).
// `defaultOdds` is the -110 the pick already carries.
function importPrice(pickText: string, g: OddsGame, defaultOdds = -110): number {
  const parsed = parsePlayerProp(pickText);
  if (!parsed || parsed.propMarket !== "TD" || !isAnytimeTdPick(pickText)) return defaultOdds;
  const name = stripTeamNamesFromPlayerName(parsed.playerName, [g.homeTeam, g.awayTeam], "NFL");
  const price = name ? resolvePropOddsFromGame(g, { playerName: name, propMarket: "TD" }) : null;
  return price !== null ? price : defaultOdds;
}

// 1. Real data has a sensible spread, not one flat price.
const lines = normalizePlayerPropLines(game).filter((l) => l.marketKey === "player_anytime_td");
const dk = lines.filter((l) => l.bookmakerKey === "draftkings").map((l) => l.price);
expect("fixture: draftkings has 28 player anytime-TD prices (30 outcomes minus 2 D/ST)", dk.length, 28);
expect("fixture: favorites to longshots (min -120, max +3000)", [Math.min(...dk), Math.max(...dk)], [-120, 3000]);
expect("fixture: many distinct prices", new Set(dk).size > 20, true);

// 2. Real captured price is used (first bookmaker = draftkings).
expect("Travis Kelce anytime TD -> draftkings +200", importPrice("Chiefs Travis Kelce Anytime TD", game), 200);
expect("Rashee Rice (mid price) -> +155", importPrice("Rashee Rice Anytime TD", game), 155);
expect("Kenneth Walker III (favorite) -> -120", importPrice("Kenneth Walker III Anytime TD", game), -120);
expect("Nikko Remigio (longshot) -> +3000", importPrice("Nikko Remigio anytime td", game), 3000);
expect("Patrick Mahomes -> +700", importPrice("Patrick Mahomes Anytime TD", game), 700);
expect("capper drops the suffix: 'Marvin Mims' matches 'Marvin Mims Jr.' -> +700", importPrice("Marvin Mims Anytime TD", game), 700);
expect("bare 'TD' wording ('Kelce TD' style full name) -> +200", importPrice("Travis Kelce TD", game), 200);

// 3. Genuine snapshot miss -> -110 (same fallback as every other market).
expect("player not in snapshot -> -110", importPrice("Nobody Realname Anytime TD", game), -110);
const noTdMarket: OddsGame = { ...game, bookmakers: game.bookmakers.map((b) => ({ ...b, markets: [] })) };
expect("game has no anytime-TD market at all -> -110", importPrice("Travis Kelce Anytime TD", noTdMarket), -110);
expect("team defense is never matched as a player ('Kansas City Chiefs D/ST' line exists) -> -110", resolvePropOddsFromGame(game, { playerName: "Kansas City Chiefs D/ST", propMarket: "TD" }), null);

// 4. Non-anytime TD shapes are NOT priced as the anytime market.
for (const [label, text] of [
  ["first TD", "Travis Kelce First TD"],
  ["first touchdown scorer", "Travis Kelce 1st Touchdown"],
  ["multi-TD 2+", "Travis Kelce 2+ TDs"],
  ["Over/Under TD count", "Travis Kelce Over 1.5 TDs"],
  ["rushing-only TD", "Travis Kelce Rushing TD"],
  ["receiving-only TD", "Travis Kelce Receiving TD"],
  ["first-half scoped", "Travis Kelce Anytime TD 1st Half"],
  ["quarter scoped", "Travis Kelce Anytime TD 2nd Quarter"],
] as const) {
  expect(`${label} stays at default -110 (not priced as anytime)`, importPrice(text, game), -110);
}

// 5. Non-TD markets unaffected by the TD path: a yards query with no side/point never matches anything.
expect("REC_YDS query without side/point -> null", resolvePropOddsFromGame(game, { playerName: "Travis Kelce", propMarket: "REC_YDS" }), null);

// 6. Grading/parsing unchanged: parseTouchdownProp output pinned for the texts grading reads.
expect("parseTouchdownProp anytime", parseTouchdownProp("Puka Nacua Anytime TD"), { playerName: "Puka Nacua", propType: "ANY", unsupported: undefined });
expect("parseTouchdownProp first-TD still unsupported", !!parseTouchdownProp("Travis Kelce First TD")?.unsupported, true);
expect("parseTouchdownProp multi-TD still unsupported", !!parseTouchdownProp("Travis Kelce 2+ TDs")?.unsupported, true);
expect("parseTouchdownProp rushing TD type", parseTouchdownProp("Travis Kelce Rushing TD")?.propType, "RUSHING");
expect("parsePlayerProp still tags TD", parsePlayerProp("Puka Nacua Anytime TD"), { playerName: "Puka Nacua", propMarket: "TD" });

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
