// recordForGate (pick-record.ts) on a player prop: a prop with a market key
// (prop-market-key.ts) is gated and ranked on its per-market record - in-league
// and all-time across the market's sport family, best of two by Wilson at
// GENERATOR_Z, as every other pick - and NEVER on its TD_PROP "Player Props"
// category record, which blends every prop market of every league. No record on
// the market is no record. A prop with no key (no propMarket) and every game
// line keep the category path, unchanged. NFL TD props have a key too.
// The generated leg names its market: "· NBA points", not "· NBA player prop".
// Pure - no DB. Run with:
//   npx tsx src/lib/parlay/prop-market-gate-acceptance-test.ts
import { buildGeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { recordForGate } from "@/lib/parlay/pick-record";
import { recordText } from "@/components/parlay/generator-result";
import { propMarketRecordKey } from "@/lib/record-keys";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { PropMarketKey } from "@/lib/prop-market-key";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords, PropMarketRecord } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const NOW = new Date("2099-06-01T12:00:00.000Z");
const START = "2099-06-01T23:00:00.000Z";
const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0, count: wins + losses });

type Spec = {
  id: string;
  league: string;
  betType: "PLAYER_PROP" | "MONEYLINE";
  propMarket: string | null;
  category: PickCategoryKey;
  // The category card (in-league, all-time) - TD_PROP for a prop.
  card: [[number, number], [number, number]] | null;
  // The per-market record (in-league, all-time) for a prop with a key.
  market?: { key: PropMarketKey; lg: [number, number]; all: [number, number] } | null;
};

function makeSnapshot(specs: Spec[]): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const propMarketRecords: Record<string, PropMarketRecord | null> = {};
  const games: GeneratorGame[] = specs.map((s, i) => {
    const capperId = "cap-" + s.id;
    const home = "Home " + i;
    const away = "Away " + i;
    if (s.card) {
      categoryRecords[capperId + "|" + s.category] = { key: s.category, label: s.category, ...col(...s.card[1]) };
      leagueRecords.records[capperId + "|" + s.league + "|" + s.category] = { category: s.category, label: s.category, overall: col(...s.card[1]), league: col(...s.card[0]) };
    }
    if (s.market) propMarketRecords[propMarketRecordKey(capperId, s.league, s.market.key)] = { key: s.market.key, league: col(...s.market.lg), allTime: col(...s.market.all) };
    const detail = s.betType === "PLAYER_PROP" ? "Some Player Over 2.5" : home.split(" ").pop() + " ML";
    const pick = {
      pickId: s.id,
      capperId,
      capperName: "Capper " + s.id,
      capperColorTag: null,
      capperIsFavorite: false,
      category: s.category,
      leagueName: s.league,
      gameId: "G" + i,
      gameLabel: away + " @ " + home,
      betDetail: detail,
      odds: -110,
      units: 1,
      status: "PENDING",
      betType: s.betType,
      period: "FULL_GAME",
      rawBetDetail: detail,
      propMarket: s.propMarket,
      line: null,
      homeTeam: home,
      awayTeam: away,
      gameTime: START,
      teamGroup: s.betType === "PLAYER_PROP" ? "OTHER" : "HOME",
      teamLabel: "",
      teamColor: null,
      datePosted: "2099-05-31T00:00:00.000Z",
    } as GeneratorPick;
    return { gameId: "G" + i, gameLabel: pick.gameLabel, gameTime: START, leagueName: s.league, picks: [pick] };
  });
  return { builtAt: NOW.toISOString(), games, slipPicks: [], targets: [], leagueRecords, categoryRecords, propMarketRecords };
}

const SPECS: Spec[] = [
  // Strong on NBA points, weak on "Player Props" as a whole: gated on points.
  { id: "nbaPts", league: "NBA", betType: "PLAYER_PROP", propMarket: "POINTS", category: "TD_PROP", card: [[2, 8], [20, 80]], market: { key: "BASKETBALL:POINTS", lg: [8, 2], all: [9, 5] } },
  // Strong on "Player Props", nothing on this market: no record - never the category's.
  { id: "noMarketRecord", league: "NBA", betType: "PLAYER_PROP", propMarket: "REBOUNDS", category: "TD_PROP", card: [[80, 20], [80, 20]], market: null },
  // A prop with no propMarket: no key, the category path as before.
  { id: "noKey", league: "NBA", betType: "PLAYER_PROP", propMarket: null, category: "TD_PROP", card: [[7, 3], [7, 3]] },
  // A game line: the category path as before.
  { id: "line", league: "NBA", betType: "MONEYLINE", propMarket: null, category: "FAV_ML", card: [[6, 4], [6, 4]] },
  // NFL anytime TD: its own market now, not TD_PROP.
  { id: "nflTd", league: "NFL", betType: "PLAYER_PROP", propMarket: "TD", category: "TD_PROP", card: [[9, 1], [9, 1]], market: { key: "FOOTBALL:TD", lg: [6, 4], all: [6, 4] } },
  // Best of two on a market: 1-2 in the NHL vs 60-40 all time -> all time.
  { id: "nhlSog", league: "NHL", betType: "PLAYER_PROP", propMarket: "SHOTS_ON_GOAL", category: "TD_PROP", card: [[0, 9], [0, 9]], market: { key: "HOCKEY:SHOTS_ON_GOAL", lg: [1, 2], all: [60, 40] } },
  // Best of two on a market: 8-0 in-league beats 60-40 all time.
  { id: "mlbKs", league: "MLB", betType: "PLAYER_PROP", propMarket: "STRIKEOUTS", category: "TD_PROP", card: [[1, 1], [1, 1]], market: { key: "BASEBALL:STRIKEOUTS", lg: [8, 0], all: [60, 40] } },
];

const snap = makeSnapshot(SPECS);
const pickOf = (id: string) => snap.games.flatMap((g) => g.picks).find((p) => p.pickId === id)!;
const gate = (id: string, withProps = true) => {
  const r = recordForGate(pickOf(id), snap.leagueRecords, snap.categoryRecords, undefined, withProps ? snap.propMarketRecords : undefined);
  return r && `${r.source} ${r.wins}-${r.losses}${r.propMarket ? " " + r.propMarket : ""}`;
};

check("NBA points prop: its points record, not Player Props", gate("nbaPts"), "LEAGUE 8-2 BASKETBALL:POINTS");
check("no record on the market: none (no TD_PROP fallback)", gate("noMarketRecord"), null);
check("a prop with no key: the category path", gate("noKey"), "LEAGUE 7-3");
check("a game line: the category path", gate("line"), "LEAGUE 6-4");
check("a game line: the same with and without prop records", gate("line", false), gate("line"));
check("a prop with no key: the same with and without prop records", gate("noKey", false), gate("noKey"));
check("NFL TD: its own market, not TD_PROP", gate("nflTd"), "LEAGUE 6-4 FOOTBALL:TD");
check("best of two on a market: all time", gate("nhlSog"), "OVERALL 60-40 HOCKEY:SHOTS_ON_GOAL");
check("best of two on a market: in-league", gate("mlbKs"), "LEAGUE 8-0 BASEBALL:STRIKEOUTS");
check("a keyed prop without the snapshot's prop records: none", gate("nbaPts", false), null);

// ---- The engine: gated on the per-market record, labelled with the market.
const SETTINGS: GeneratorSettings = { legCount: 7, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const built = buildGeneratedParlay(snap, SETTINGS, null, NOW);
const legIds = built.legs.map((l) => l.pick.pickId).sort();
// nbaPts (80%), noKey (70%), line (60%), nflTd (60%), nhlSog (60%), mlbKs (100%) clear 55%; noMarketRecord has no record.
check("legs: every pick that clears 55% on its own record", legIds, ["line", "mlbKs", "nbaPts", "nflTd", "nhlSog", "noKey"]);
check("a prop strong only on Player Props is never a leg", legIds.includes("noMarketRecord"), false);
const text = (id: string) => {
  const l = built.legs.find((x) => x.pick.pickId === id)!;
  return recordText(l.record, l.basis, l.pick, l.propMarket);
};
check("label: NBA points", text("nbaPts"), "80% (8–2) · NBA points");
check("label: all leagues shots on goal", text("nhlSog"), "60% (60–40) · all leagues shots on goal");
check("label: NFL touchdowns", text("nflTd"), "60% (6–4) · NFL touchdowns");
check("label: MLB pitcher strikeouts", text("mlbKs"), "100% (8–0) · MLB pitcher strikeouts");
check("label: a prop with no key keeps the category noun", text("noKey"), "70% (7–3) · NBA player prop");
check("label: a game line keeps the category noun", text("line"), "60% (6–4) · NBA favorite moneyline");
check("only per-market legs carry propMarket", built.legs.filter((l) => l.propMarket).map((l) => l.pick.pickId).sort(), ["mlbKs", "nbaPts", "nflTd", "nhlSog"]);
check("a swap's label names its market the same way", recordText({ wins: 6, losses: 2, n: 8, winPct: 75 }, "OVERALL", pickOf("nbaPts"), "BASKETBALL:POINTS"), "75% (6–2) · all leagues points");

// ---- A snapshot with no prop at all builds exactly as before (no propMarketRecords field).
const linesOnly = makeSnapshot(SPECS.filter((s) => s.betType === "MONEYLINE"));
const { propMarketRecords: _, ...legacyShape } = linesOnly;
check(
  "game-line parlay identical with and without the prop records field",
  JSON.stringify(buildGeneratedParlay(legacyShape, SETTINGS, null, NOW)),
  JSON.stringify(buildGeneratedParlay(linesOnly, SETTINGS, null, NOW))
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
