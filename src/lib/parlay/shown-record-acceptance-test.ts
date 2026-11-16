// What a Parlay Generator leg and swap row SHOW (PR C): shownRecord (pick-record.ts)
// and legRecordLabel (swap-modal.ts) - the capper's real, unweighted record in the
// category across every league, the category in plain words, and the in-league
// slice: "50% (6–6) · Underdog spread · NFL 1–0". Display only: the gate
// (scoring.ts) is unchanged, and the shown record is exactly the raw record its
// long-shot rule reads. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/shown-record-acceptance-test.ts
import { shownRecord } from "@/lib/parlay/pick-record";
import { categoryName, isHot, legRecordLabel, strengthOrder, winTier } from "@/lib/parlay/swap-modal";
import { EMPTY_PLATFORM_RATES, scorePick, type ScoringContext } from "@/lib/parlay/scoring";
import { buildGeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { propMarketRecordKey } from "@/lib/record-keys";
import { WIN_RATE_HELP, WIN_RATE_HELP_MORE } from "@/lib/parlay/gate";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords, PropMarketRecord } from "@/server/data/picks";
import type { PropMarketKey } from "@/lib/prop-market-key";

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
  category: PickCategoryKey;
  betType?: string;
  propMarket?: string | null;
  odds?: number;
  // [in-league, all leagues] category card.
  card?: [[number, number], [number, number]];
  market?: { key: PropMarketKey; lg: [number, number]; all: [number, number] };
};

function snapshotOf(specs: Spec[]): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const propMarketRecords: Record<string, PropMarketRecord | null> = {};
  const games = specs.map((s, i) => {
    const capperId = "cap-" + s.id;
    if (s.card) {
      categoryRecords[capperId + "|" + s.category] = { key: s.category, label: s.category, ...col(...s.card[1]) };
      leagueRecords.records[capperId + "|" + s.league + "|" + s.category] = { category: s.category, label: s.category, overall: col(...s.card[1]), league: col(...s.card[0]) };
    }
    if (s.market) propMarketRecords[propMarketRecordKey(capperId, s.league, s.market.key)] = { key: s.market.key, league: col(...s.market.lg), allTime: col(...s.market.all) };
    const home = "Home " + i;
    const away = "Away " + i;
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
      betDetail: "detail " + s.id,
      odds: s.odds ?? -110,
      oddsSource: "MARKET",
      units: 1,
      status: "PENDING",
      betType: s.betType ?? "SPREAD",
      period: "FULL_GAME",
      rawBetDetail: "detail " + s.id,
      propMarket: s.propMarket ?? null,
      line: null,
      homeTeam: home,
      awayTeam: away,
      gameTime: START,
      teamGroup: "HOME",
      teamLabel: "",
      teamColor: null,
      datePosted: "2099-05-31T00:00:00.000Z",
    } as unknown as GeneratorPick;
    return { gameId: "G" + i, gameLabel: pick.gameLabel, gameTime: START, leagueName: s.league, picks: [pick] };
  });
  return { builtAt: NOW.toISOString(), games, slipPicks: [], targets: [], leagueRecords, categoryRecords, propMarketRecords };
}

const pickIn = (snap: GeneratorSnapshot, id: string) => snap.games.flatMap((g) => g.picks).find((p) => p.pickId === id)!;
const shown = (snap: GeneratorSnapshot, id: string) => shownRecord(pickIn(snap, id), snap.leagueRecords, snap.categoryRecords, snap.propMarketRecords ?? {});
const label = (snap: GeneratorSnapshot, id: string) => {
  const r = shown(snap, id);
  const p = pickIn(snap, id);
  return legRecordLabel(r, r?.source ?? null, p, r?.propMarket, r?.league);
};
const ctxOf = (snap: GeneratorSnapshot, minWinPct: number): ScoringContext => ({
  leagueRecords: snap.leagueRecords,
  categoryRecords: snap.categoryRecords,
  propMarketRecords: snap.propMarketRecords,
  platformRates: EMPTY_PLATFORM_RATES,
  minWinPct,
});
// The raw record scoring.ts's long-shot rule reads: in-league plus other leagues.
const rawRead = (snap: GeneratorSnapshot, id: string) => {
  const s = scorePick(pickIn(snap, id), ctxOf(snap, 55));
  return s.status === "SCORED" ? `${s.levels.league.wins + s.levels.otherLeagues.wins}-${s.levels.league.losses + s.levels.otherLeagues.losses}` : null;
};

// ============================================================================
// (a) A tiny in-league slice next to a larger other-league record (the Tierney shape)
// ============================================================================
{
  // NFL underdog spread 1-0, every league 6-6 (NCAAF 5-6).
  const snap = snapshotOf([{ id: "tierney", league: "NFL", category: "SPREAD_PLUS", card: [[1, 0], [6, 6]] }]);
  check("shown: the real 6-6, never the 1-0 slice alone", shown(snap, "tierney"), { wins: 6, losses: 6, winPct: 50, n: 12, source: "OVERALL", league: { wins: 1, losses: 0 } });
  check("label", label(snap, "tierney"), "50% (6–6) · Underdog spread · NFL 1–0");
  check("the shown record is the raw record the gate's long-shot rule reads", rawRead(snap, "tierney"), "6-6");
  check("win-rate colour and Hot read the shown 50%, not 100%", [winTier(shown(snap, "tierney")!.winPct), isHot(shown(snap, "tierney")!.winPct)], ["LOW", false]);
}

// ============================================================================
// (b) A large in-league record that dominates the combined one
// ============================================================================
{
  // NBA favorite moneyline 40-10 in the NBA, 45-12 everywhere (5-2 elsewhere).
  const snap = snapshotOf([{ id: "big", league: "NBA", category: "FAV_ML", betType: "MONEYLINE", card: [[40, 10], [45, 12]] }]);
  check("label: the combined record barely moves off the in-league one", label(snap, "big"), "79% (45–12) · Favorite moneyline · NBA 40–10");
  check("Hot and colour read the shown 79%", [winTier(shown(snap, "big")!.winPct), isHot(shown(snap, "big")!.winPct)], ["STRONG", true]);
  check("raw read matches", rawRead(snap, "big"), "45-12");
  // No pick in this league yet: the slice still shows, 0-0.
  const fresh = snapshotOf([{ id: "fresh", league: "NHL", category: "UNDER", betType: "TOTAL", card: [[0, 0], [12, 8]] }]);
  check("no in-league pick yet: NHL 0–0", label(fresh, "fresh"), "60% (12–8) · Under · NHL 0–0");
  // No card, only the all-leagues map: the slice is 0-0 too.
  const noCard = snapshotOf([{ id: "nc", league: "MLB", category: "F5_OVER", betType: "TOTAL" }]);
  noCard.categoryRecords["cap-nc|F5_OVER"] = { key: "F5_OVER", label: "F5_OVER", ...col(7, 3) };
  check("no card: the all-leagues map, MLB 0–0", label(noCard, "nc"), "70% (7–3) · First-5 over · MLB 0–0");
  check("no record anywhere", [shown(snapshotOf([{ id: "none", league: "NFL", category: "SPREAD_MINUS" }]), "none"), legRecordLabel(null, null, { category: "SPREAD_MINUS", leagueName: "NFL" })], [null, "No record yet"]);
}

// ============================================================================
// (c) Props: the per-market record, across the sport family, with the in-league slice
// ============================================================================
{
  const snap = snapshotOf([
    { id: "pts", league: "NBA", category: "PTS_PROP", betType: "PLAYER_PROP", propMarket: "POINTS", card: [[2, 8], [20, 80]], market: { key: "BASKETBALL:POINTS", lg: [1, 0], all: [11, 9] } },
    { id: "wnbaPts", league: "WNBA", category: "PTS_PROP", betType: "PLAYER_PROP", propMarket: "POINTS", market: { key: "BASKETBALL:POINTS", lg: [10, 9], all: [11, 9] } },
  ]);
  check("a prop: its market, never the category card", label(snap, "pts"), "55% (11–9) · Points · NBA 1–0");
  check("the same market from the other league in the family", label(snap, "wnbaPts"), "55% (11–9) · Points · WNBA 10–9");
  check("props: raw read matches the shown record", rawRead(snap, "pts"), "11-9");
}

// ============================================================================
// (d) Label formatting and the category names
// ============================================================================
check(
  "category names",
  (["SPREAD_PLUS", "SPREAD_MINUS", "FAV_ML", "DOG_ML", "OVER", "UNDER", "F5_OVER", "FIRST_HALF_SPREAD", "TEAM_TOTAL", "NRFI"] as PickCategoryKey[]).map((c) => categoryName(c)),
  ["Underdog spread", "Favorite spread", "Favorite moneyline", "Underdog moneyline", "Over", "Under", "First-5 over", "First-half spread", "Team total", "NRFI"]
);
check("a prop market names the market", categoryName("PTS_PROP", "BASKETBALL:POINTS"), "Points");
check("no category", categoryName(null), "This market");
check("rounds the %", legRecordLabel({ wins: 2, losses: 1, winPct: 66.666 }, "OVERALL", { category: "OVER", leagueName: "NBA" }, undefined, { wins: 1, losses: 1 }), "67% (2–1) · Over · NBA 1–1");
check("a slip pick on its last 20", legRecordLabel({ wins: 11, losses: 9, winPct: 55 }, "LAST20", { category: "OVER", leagueName: "NBA" }), "55% (11–9) · last 20 picks");
check("LEAGUE with no slice given: the record is its own slice", legRecordLabel({ wins: 3, losses: 1, winPct: 75 }, "LEAGUE", { category: "DOG_ML", leagueName: "NHL" }), "75% (3–1) · Underdog moneyline · NHL 3–1");
check("OVERALL with no slice given: names none rather than guess", legRecordLabel({ wins: 3, losses: 1, winPct: 75 }, "OVERALL", { category: "DOG_ML", leagueName: "NHL" }), "75% (3–1) · Underdog moneyline");

// ============================================================================
// The engine: legs carry the shown record; the gate is unchanged
// ============================================================================
{
  const snap = snapshotOf([
    { id: "tierney", league: "NFL", category: "SPREAD_PLUS", card: [[1, 0], [6, 6]] },
    { id: "big", league: "NBA", category: "FAV_ML", betType: "MONEYLINE", card: [[40, 10], [45, 12]] },
    { id: "mid", league: "NHL", category: "UNDER", betType: "TOTAL", card: [[6, 4], [30, 20]] },
  ]);
  const settings: GeneratorSettings = { legCount: 3, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE", minWinPct: 0 };
  const built = buildGeneratedParlay(snap, settings, null, NOW);
  const leg = (id: string) => built.legs.find((l) => l.pick.pickId === id)!;
  check("every leg at 0%", built.legs.map((l) => l.pick.pickId).sort(), ["big", "mid", "tierney"]);
  check(
    "each leg carries the shown record and its slice",
    ["tierney", "big", "mid"].map((id) => legRecordLabel(leg(id).record, leg(id).basis, leg(id).pick, leg(id).propMarket, leg(id).leagueSlice)),
    ["50% (6–6) · Underdog spread · NFL 1–0", "79% (45–12) · Favorite moneyline · NBA 40–10", "60% (30–20) · Under · NHL 6–4"]
  );
  check("strongest first reads the shown %: 79, 60, 50", strengthOrder(built.legs).map((i) => built.legs[i].pick.pickId), ["big", "mid", "tierney"]);
  // The gate is scoring.ts's, untouched: the same pass/fail at 46 and 55 as scorePick says.
  for (const L of [46, 55]) {
    const passing = ["tierney", "big", "mid"].filter((id) => {
      const s = scorePick(pickIn(snap, id), ctxOf(snap, L));
      return s.status === "SCORED" && s.gate.passes;
    });
    const legs = buildGeneratedParlay(snap, { ...settings, minWinPct: L }, null, NOW).legs.map((l) => l.pick.pickId);
    check(`gate at ${L}: legs are exactly what scoring.ts passes`, legs.sort(), passing.sort());
  }
}

// The help line under Minimum capper win rate: one short line, the rest behind the info icon.
check("win-rate help line", WIN_RATE_HELP, "Judged on each capper's record in that bet type, weighted toward the same league.");
check("the longer help keeps the price example", WIN_RATE_HELP_MORE.includes("10-10 capper betting +200"), true);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
