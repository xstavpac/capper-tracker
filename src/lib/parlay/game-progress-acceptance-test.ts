// Proof for game-progress.ts and the "started games stay in the pool" rule: a game
// that has kicked off stays eligible until its sport's progress cutoff (NBA/WNBA/NFL/
// NCAAF through Q3, NCAAB through 1H, NHL through P2, MLB through the 6th); unknown
// progress and final/postponed/cancelled are out. The window, snapshotIsStale and the
// Swap modal all follow it; a missing score reads as changed, never 0-0; the state
// line formats; and nothing in the pool path changes a pick's stored odds.
// Pure: no DB, no network. Run with:
//   npx tsx src/lib/parlay/game-progress-acceptance-test.ts
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  inningNumber,
  poolEligible,
  PRICE_EST_UNCHANGED,
  PRICE_PREGAME_LINE,
  startedPriceLabel,
  startedStateLine,
  withinProgressCutoff,
  withLiveState,
  type GameLiveState,
} from "@/lib/parlay/game-progress";
import { autoGenerateWindow } from "@/lib/parlay/auto-generate-window";
import { buildGeneratedParlay, legAlternatives, snapshotIsStale, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GameFeedStatus } from "@/lib/parlay/game-over";
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { StartedLine as StartedLineType } from "@/components/parlay/started-line";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " - expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)));
}

const NOW = new Date("2099-06-01T23:00:00.000Z");
const STARTED = "2099-06-01T22:00:00.000Z";
const LATER = "2099-06-02T01:00:00.000Z";

const state = (over: Partial<GameLiveState> = {}): GameLiveState => ({ period: null, clock: null, inningHalf: null, inning: null, away: 0, home: 0, scoreMissing: false, ...over });
const live = (leagueName: string, s: Partial<GameLiveState>, gameStatus: GameFeedStatus | null = "live") => ({ gameTime: STARTED, leagueName, gameStatus, liveState: state(s) });

// ---- 1. cutoffs, per sport ----
for (const league of ["NBA", "WNBA", "NFL", "NCAAF"]) {
  check(league + ": Q1-Q3 in, Q4 and OT out", [1, 2, 3, 4, 5].map((period) => poolEligible(live(league, { period, clock: "5:00" }), NOW)), [true, true, true, false, false]);
  check(league + ": end of Q3 (0:00 / 0.0) out - Q3 has ended", [poolEligible(live(league, { period: 3, clock: "0:00" }), NOW), poolEligible(live(league, { period: 3, clock: "0.0" }), NOW)], [false, false]);
  check(league + ": Q3 in progress (0:01 left) in; halftime (end of Q2) in", [poolEligible(live(league, { period: 3, clock: "0:01" }), NOW), poolEligible(live(league, { period: 2, clock: "0.0" }), NOW)], [true, true]);
}
check("NCAAB: 1st half in, halftime out, 2nd half and OT out", [poolEligible(live("NCAAB", { period: 1, clock: "8:40" }), NOW), poolEligible(live("NCAAB", { period: 1, clock: "0.0" }), NOW), poolEligible(live("NCAAB", { period: 2, clock: "19:50" }), NOW), poolEligible(live("NCAAB", { period: 3, clock: "4:00" }), NOW)], [true, false, false, false]);
check("NHL: P1-P2 in, P3 and OT out", [1, 2, 3, 4].map((period) => poolEligible(live("NHL", { period }), NOW)), [true, true, false, false]);
check("NHL: 2nd period in progress in", poolEligible(live("NHL", { period: 2, clock: "5:01" }), NOW), true);
check("NHL: 2nd intermission (P2, 0:00) out", [poolEligible(live("NHL", { period: 2, clock: "0:00" }), NOW), poolEligible(live("NHL", { period: 2, clock: "0.0" }), NOW)], [false, false]);
check("NHL: 1st intermission (P1, 0:00) in", poolEligible(live("NHL", { period: 1, clock: "0:00" }), NOW), true);
check("NHL: 3rd period, OT, shootout out", [poolEligible(live("NHL", { period: 3, clock: "15:00" }), NOW), poolEligible(live("NHL", { period: 4, clock: "3:00" }), NOW), poolEligible(live("NHL", { period: 5, clock: "0:00" }), NOW)], [false, false, false]);

// ---- backstop: time since the scheduled start, whatever the feed says ----
{
  const at = (minutes: number) => new Date(new Date(STARTED).getTime() + minutes * 60_000);
  const nhlP1 = live("NHL", { period: 1, clock: "12:00" });
  check("NHL backstop: stale 'live P1' in at 110 min, out at 111", [poolEligible(nhlP1, at(110)), poolEligible(nhlP1, at(111))], [true, false]);
  check("NHL backstop: the 2026-11-24 case - stale P1/P2 read 159 min after puck drop is out", [poolEligible(nhlP1, at(159)), poolEligible(live("NHL", { period: 2, clock: "8:00" }), at(159))], [false, false]);
  const stalePreview = { gameTime: STARTED, leagueName: "NHL", gameStatus: "preview" as const };
  check("NHL backstop: stale 'preview' (delayed start) in at 60 min, out at 111", [poolEligible(stalePreview, at(60)), poolEligible(stalePreview, at(111))], [true, false]);
  check("NHL backstop: no feed status at all, past the backstop: out", poolEligible({ gameTime: STARTED, leagueName: "NHL", gameStatus: null }, at(200)), false);
  const backstops: [string, number, GameLiveState["period"]][] = [["NBA", 125, 2], ["WNBA", 110, 2], ["NFL", 165, 2], ["NCAAF", 180, 2], ["NCAAB", 65, 1]];
  for (const [league, minutes, period] of backstops) {
    const g = live(league, { period, clock: "5:00" });
    check(league + " backstop: within-cutoff read in at " + minutes + " min, out after", [poolEligible(g, at(minutes)), poolEligible(g, at(minutes + 1))], [true, false]);
    const p = { gameTime: STARTED, leagueName: league, gameStatus: "preview" as const };
    check(league + " backstop: stale 'preview' out after " + minutes + " min", poolEligible(p, at(minutes + 1)), false);
  }
  const mlb = live("MLB", { inningHalf: "Top", inning: 3 });
  check("MLB backstop: in at 130 min, out after", [poolEligible(mlb, at(130)), poolEligible(mlb, at(131))], [true, false]);
  check("no-cutoff league: delayed start out after 60 min", [poolEligible({ gameTime: STARTED, leagueName: "CFL", gameStatus: "preview" }, at(60)), poolEligible({ gameTime: STARTED, leagueName: "CFL", gameStatus: "preview" }, at(61))], [true, false]);
  check("backstop never touches a game that has not started", poolEligible({ gameTime: "2099-06-03T00:00:00.000Z", leagueName: "NHL", gameStatus: "preview" }, at(500)), true);
  const win = autoGenerateWindow("NHL", [STARTED], at(159));
  check("window: NHL stale P1 at 159 min out", win(STARTED, { gameStatus: "live", liveState: state({ period: 1, clock: "10:00" }) }), false);
  const nhlGame = { gameId: "N1", gameLabel: "Kings @ Canadiens", gameTime: STARTED, gameStatus: "live" as const, liveState: state({ period: 1, clock: "10:00" }), leagueName: "NHL", picks: [] };
  check("stale? yes: an NHL game past its backstop drops on the reload check", snapshotIsStale({ builtAt: at(159).toISOString(), games: [nhlGame], slipPicks: [], targets: [] }, at(159)), true);
  check("stale? no: a target's game stays past the backstop (exempt, as before)", snapshotIsStale({ builtAt: at(159).toISOString(), games: [nhlGame], slipPicks: [], targets: ["N1"] }, at(159)), false);
}
check(
  "MLB: through the 6th in (End 6th in), Top 7th out",
  [
    poolEligible(live("MLB", { inningHalf: "Top", inning: 1 }), NOW),
    poolEligible(live("MLB", { inningHalf: "Bottom", inning: 6 }), NOW),
    poolEligible(live("MLB", { inningHalf: "End", inning: 6 }), NOW),
    poolEligible(live("MLB", { inningHalf: "Top", inning: 7 }), NOW),
  ],
  [true, true, true, false]
);
check("MLB goes by inning, not period", poolEligible(live("MLB", { period: 2 }), NOW), false);
check("inningNumber parses the ordinal", [inningNumber("5th"), inningNumber("11th"), inningNumber(null), inningNumber("Top")], [5, 11, null, null]);

// ---- unknown progress, over, not started ----
check("live with no period: out", poolEligible(live("NBA", {}), NOW), false);
check("live with no state at all: out", poolEligible({ gameTime: STARTED, leagueName: "NBA", gameStatus: "live" }, NOW), false);
check("started, no feed status: out", poolEligible({ gameTime: STARTED, leagueName: "NBA", gameStatus: null, liveState: state({ period: 1 }) }, NOW), false);
check("a league with no cutoff: out", withinProgressCutoff("CFL", state({ period: 1 })), false);
for (const s of ["final", "postponed", "cancelled"] as const) {
  check(s + ": out even within the cutoff", poolEligible(live("NBA", { period: 1 }, s), NOW), false);
}
check("delayed start (feed still preview after kickoff): in", poolEligible({ gameTime: STARTED, leagueName: "NBA", gameStatus: "preview" }, NOW), true);
check("not started: in", poolEligible({ gameTime: LATER, leagueName: "NBA" }, NOW), true);

// ---- 4. price label: scoreMissing is changed, never 0-0 ----
check("0-0 with the score present: est. · score unchanged", startedPriceLabel({ gameStatus: "live", liveState: state({ period: 1 }) }), PRICE_EST_UNCHANGED);
check("score changed: pregame line", startedPriceLabel({ gameStatus: "live", liveState: state({ period: 1, away: 2, home: 0 }) }), PRICE_PREGAME_LINE);
check("scoreMissing (shown as 0-0 by the feed): treated as changed", startedPriceLabel({ gameStatus: "live", liveState: state({ period: 1, scoreMissing: true }) }), PRICE_PREGAME_LINE);
check("a null side: treated as changed", startedPriceLabel({ gameStatus: "live", liveState: state({ period: 1, home: null }) }), PRICE_PREGAME_LINE);
check("no state: treated as changed", startedPriceLabel({ gameStatus: "live" }), PRICE_PREGAME_LINE);
check("delayed start: unchanged", startedPriceLabel({ gameStatus: "preview" }), PRICE_EST_UNCHANGED);

// ---- 2. the state line ----
check("NBA line", startedStateLine("NBA", state({ period: 2, clock: "4:12", away: 45, home: 41 })), "Started · Q2 4:12 · 45-41");
check("MLB line", startedStateLine("MLB", state({ inningHalf: "Top", inning: 5, away: 2, home: 1 })), "Started · Top 5th · 2-1");
check("halftime / end of Q3", [startedStateLine("NBA", state({ period: 2, clock: "0.0" })), startedStateLine("NFL", state({ period: 3, clock: "0:00" }))], ["Started · Half · 0-0", "Started · End Q3 · 0-0"]);
check("NCAAB / NHL / OT", [startedStateLine("NCAAB", state({ period: 1, clock: "8:40", away: 20, home: 18 })), startedStateLine("NHL", state({ period: 2, clock: "5:01", away: 1, home: 0 })), startedStateLine("NBA", state({ period: 5, clock: "2:00", away: 100, home: 100 }))], ["Started · 1H 8:40 · 20-18", "Started · P2 5:01 · 1-0", "Started · OT 2:00 · 100-100"]);
check("scoreMissing: no score shown", startedStateLine("NBA", state({ period: 1, clock: "9:00", scoreMissing: true })), "Started · Q1 9:00");
check("nothing known: just Started", [startedStateLine("NBA", null), startedStateLine("MLB", state({ away: null, home: null }))], ["Started", "Started"]);

// ---- 3. the window: a started game stays while eligible ----
{
  const inWindow = autoGenerateWindow("NBA", [STARTED, LATER], NOW);
  check("window: a later game today is in", inWindow(LATER), true);
  check("window: started, Q2: in", inWindow(STARTED, { gameStatus: "live", liveState: state({ period: 2 }) }), true);
  check("window: started, Q4: out", inWindow(STARTED, { gameStatus: "live", liveState: state({ period: 4 }) }), false);
  check("window: started, final: out", inWindow(STARTED, { gameStatus: "final", liveState: state({ period: 2 }) }), false);
  check("window: started, nothing known (old callers): out", inWindow(STARTED), false);
}

// ---- generator fixture: three MLB games, all kicked off an hour ago ----
const TEAMS: [string, string][] = [["New York Yankees", "Boston Red Sox"], ["Toronto Blue Jays", "Tampa Bay Rays"], ["Houston Astros", "Baltimore Orioles"], ["Cleveland Guardians", "Detroit Tigers"]];
const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
function pick(id: string, game: number, gameTime: string, odds: number): GeneratorPick {
  const [home, away] = TEAMS[game];
  leagueRecords.records["cap-" + id + "|MLB|FAV_ML"] = { category: "FAV_ML", label: "FAV_ML", overall: { wins: 30, losses: 10, pushes: 0, winPct: 75, count: 40 }, league: { wins: 30, losses: 10, pushes: 0, winPct: 75, count: 40 } };
  return {
    pickId: id, capperId: "cap-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category: "FAV_ML", leagueName: "MLB",
    gameId: "G" + game, gameLabel: away + " @ " + home, betDetail: home + " ML", odds, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME",
    rawBetDetail: home + " ML", propMarket: null, line: null, homeTeam: home, awayTeam: away, gameTime, teamGroup: "HOME", teamLabel: "", teamColor: null,
    datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}
function game(n: number, gameTime: string, odds: number, gameStatus?: GameFeedStatus, liveState?: GameLiveState): GeneratorGame {
  const p = withLiveState(pick("p" + n, n, gameTime, odds), liveState ?? null);
  return { gameId: "G" + n, gameLabel: p.gameLabel, gameTime, ...(gameStatus ? { gameStatus } : {}), ...(liveState ? { liveState } : {}), leagueName: "MLB", picks: [{ ...p, gameStatus }] };
}
const eligible = game(0, STARTED, -150, "live", state({ inningHalf: "Top", inning: 3, away: 1, home: 0 }));
const pregame = game(1, LATER, +120);
const pastCutoff = game(2, STARTED, -200, "live", state({ inningHalf: "Top", inning: 8, away: 4, home: 2 }));
const pregame2 = game(3, LATER, +105);
const SETTINGS: GeneratorSettings = { legCount: 2, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const snapOf = (games: GeneratorGame[], over: Partial<GeneratorSnapshot> = {}): GeneratorSnapshot => ({
  builtAt: NOW.toISOString(), games, slipPicks: [], targets: [], leagueRecords, categoryRecords: {}, propMarketRecords: {}, ...over,
});

// ---- snapshotIsStale: the 2-minute reload keeps an eligible started game ----
check("stale? no: a started game within its cutoff is kept", snapshotIsStale(snapOf([eligible, pregame]), NOW), false);
check("stale? yes: a started game past its cutoff drops", snapshotIsStale(snapOf([pastCutoff, pregame]), NOW), true);
check("stale? yes: a started game with no progress known drops", snapshotIsStale(snapOf([{ ...eligible, liveState: null }, pregame]), NOW), true);
check("stale? yes: a final game drops", snapshotIsStale(snapOf([{ ...eligible, gameStatus: "final" }, pregame]), NOW), true);
check("stale? no: past its cutoff but a slip pick's game stays", snapshotIsStale(snapOf([pastCutoff, pregame], { slipPicks: [pastCutoff.picks[0]] }), NOW), false);
check("stale? yes: still older than 2 minutes", snapshotIsStale(snapOf([eligible, pregame], { builtAt: new Date(NOW.getTime() - 121_000).toISOString() }), NOW), true);

// ---- Swap modal: Other games offers an eligible started game, never one past its cutoff ----
{
  const snapshot = snapOf([eligible, pregame, pastCutoff, pregame2]);
  // One leg, on the pregame game G1; its Other games tab is read against the whole pool.
  const one = { ...SETTINGS, legCount: 1 };
  const built = buildGeneratedParlay(snapOf([pregame]), one, null, NOW);
  check("swap fixture: the one leg is on G1", built.legs.map((l) => l.gameId), ["G1"]);
  const offered = legAlternatives(snapshot, one, built.legs, 0, NOW).otherGames.map((o) => o.gameId).sort();
  check("swap: Other games offers the eligible started game and the pregame one, never the one past its cutoff", offered, ["G0", "G3"]);
  const onStarted = buildGeneratedParlay(snapOf([eligible]), one, null, NOW);
  check("swap: an eligible started leg's own game is not 'game started'", legAlternatives(snapshot, one, onStarted.legs, 0, NOW).gameStarted ?? false, false);
  const onPast = buildGeneratedParlay(snapOf([pastCutoff]), one, null, NOW);
  check("swap: a leg whose game is past its cutoff says 'game started'", legAlternatives(snapshot, one, onPast.legs, 0, NOW).gameStarted ?? false, true);
}

// ---- 5. no mutation of stored odds ----
{
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o as object)) deepFreeze(v);
    }
    return o;
  };
  const storedPick = pick("s", 0, STARTED, -135);
  const snapshot = deepFreeze(snapOf([eligible, pregame, pregame2]));
  const before = JSON.stringify(snapshot);
  let threw = false;
  let legOdds: number[] = [];
  try {
    const built = buildGeneratedParlay(snapshot, { ...SETTINGS, legCount: 3 }, null, NOW);
    legOdds = built.legs.map((l) => l.pick.odds).sort((a, b) => a - b);
    snapshotIsStale(snapshot, NOW);
    legAlternatives(snapshot, SETTINGS, built.legs, 0, NOW);
  } catch (err) {
    threw = true;
    console.log(String(err));
  }
  check("frozen snapshot with a started game: build, reload check and swap never write to it", [threw, JSON.stringify(snapshot) === before], [false, true]);
  check("legs keep the stored (pregame) odds exactly", legOdds, [-150, 105, 120]);
  const stored = deepFreeze(storedPick);
  const withState = withLiveState(stored, state({ inning: 2, away: 3, home: 0 }));
  check("withLiveState copies: the stored pick is untouched, odds unchanged", [stored.liveState, withState.odds, withState === stored, withState.liveState?.away], [undefined, -135, false, 3]);
  check("withLiveState with no state returns the pick itself", withLiveState(stored, null) === stored, true);
}

async function main() {
  // ---- the rendered line ----
  (globalThis as { React?: unknown }).React = React;
  const { StartedLine } = (await import("@/components/parlay/started-line")) as { StartedLine: typeof StartedLineType };
  const html = (g: Parameters<typeof StartedLineType>[0]["game"]) => renderToStaticMarkup(React.createElement(StartedLine, { game: g, now: NOW }));
  const shown = html({ gameTime: STARTED, gameStatus: "live", leagueName: "NBA", liveState: state({ period: 2, clock: "4:12", away: 45, home: 41 }) });
  check("rendered: state line and the pregame-line label", [shown.includes("Started · Q2 4:12 · 45-41"), shown.includes(PRICE_PREGAME_LINE)], [true, true]);
  const zero = html({ gameTime: STARTED, gameStatus: "live", leagueName: "NHL", liveState: state({ period: 1, clock: "12:00" }) });
  check("rendered: 0-0 says est. · score unchanged", [zero.includes("Started · P1 12:00 · 0-0"), zero.includes(PRICE_EST_UNCHANGED)], [true, true]);
  check("rendered: nothing before kickoff or once final", [html({ gameTime: LATER, leagueName: "NBA" }), html({ gameTime: STARTED, gameStatus: "final", leagueName: "NBA" })], ["", ""]);

  if (failures) {
    console.log(failures + " failure(s)");
    process.exit(1);
  }
  console.log("All game-progress checks passed");
}
main();
