// "Include live games" (include-live.ts, generator.ts qualifyPick / buildSwap / legAlternatives). Pure - no DB.
//   npx tsx src/lib/parlay/include-live-acceptance-test.ts
//
// Off: no generated leg from a started game on Generate (rank order and a Generate draw), Regenerate (200
// seeds), Hedge / Contrarian (every Swap setting) or the Swap modal (This game / Other games); a slip pick
// on a started game is still a leg; a targeted started game is skipped and named (liveTargets). On, or
// absent: the build is exactly the one before the switch existed. "Started" is the scheduled start passed:
// a game the feed already calls live whose scheduled start is still ahead is NOT live.
import {
  buildGeneratedParlay,
  generateVariation,
  legAlternatives,
  type GeneratedParlay,
  type GeneratorSettings,
  type GeneratorSnapshot,
  type Variation,
} from "@/lib/parlay/generator";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GameLiveState } from "@/lib/parlay/game-progress";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { keepsLiveGame, normalizeIncludeLive, readStoredIncludeLive, writeStoredIncludeLive } from "@/lib/parlay/include-live";
import { traceSettings } from "@/lib/parlay/generator-trace";
import { TraceCollector } from "@/lib/parlay/run-trace";
import { SWAP_SCOPES } from "@/lib/parlay/swap-scope";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const NOW = new Date("2099-06-01T23:00:00.000Z");
const STARTED = "2099-06-01T22:00:00.000Z"; // an hour ago
const LATER = "2099-06-02T01:00:00.000Z"; // two hours ahead
const IN_3RD: GameLiveState = { period: null, clock: null, inningHalf: "Top", inning: 3, away: 1, home: 2, scoreMissing: false };
const TEAMS: [string, string][] = [
  ["New York Yankees", "Boston Red Sox"],
  ["Toronto Blue Jays", "Tampa Bay Rays"],
  ["Houston Astros", "Baltimore Orioles"],
  ["Cleveland Guardians", "Detroit Tigers"],
  ["Seattle Mariners", "Texas Rangers"],
  ["Los Angeles Dodgers", "San Francisco Giants"],
];
// Games 0-2 started (live, 3rd inning: inside MLB's cutoff), 3-5 later. The live games' picks are the
// strongest, so with the switch on they are the ones taken.
const LIVE_GAMES = new Set(["G0", "G1", "G2"]);
type Bet = "HOME" | "AWAY" | "OVER" | "UNDER";
const BETS: Bet[] = ["HOME", "AWAY", "OVER", "UNDER"];

function makeSnapshot(opts: { slip?: string[]; targets?: string[]; feedLiveButFuture?: boolean } = {}): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const games: GeneratorGame[] = [];
  const all = new Map<string, GeneratorPick>();
  TEAMS.forEach(([home, away], g) => {
    const gameId = "G" + g;
    const live = LIVE_GAMES.has(gameId);
    const gameTime = live ? STARTED : LATER;
    const gameStatus = live || (opts.feedLiveButFuture && g === 3) ? ("live" as const) : ("preview" as const);
    const liveState = live || (opts.feedLiveButFuture && g === 3) ? IN_3RD : null;
    const picks: GeneratorPick[] = BETS.map((bet, b) => {
      const id = `${gameId}-${bet}`;
      const category: PickCategoryKey = bet === "HOME" ? "FAV_ML" : bet === "AWAY" ? "DOG_ML" : bet;
      const capperId = "cap-" + id;
      // Live games strongest; within a game HOME > OVER > UNDER > AWAY.
      const wins = (live ? 80 : 66) - g - [0, 6, 2, 4][b];
      const losses = 100 - wins;
      const winPct = wins;
      categoryRecords[capperId + "|" + category] = { key: category, label: category, wins, losses, pushes: 0, winPct, count: 100 };
      leagueRecords.records[capperId + "|MLB|" + category] = {
        category,
        label: category,
        overall: { wins, losses, pushes: 0, winPct, count: 100 },
        league: { wins, losses, pushes: 0, winPct, count: 100 },
      };
      const betType = bet === "HOME" || bet === "AWAY" ? "MONEYLINE" : "TOTAL";
      const detail = bet === "HOME" ? home + " ML" : bet === "AWAY" ? away + " ML" : `${bet === "OVER" ? "Over" : "Under"} 8.5`;
      const p = {
        pickId: id,
        capperId,
        capperName: "Capper " + id,
        capperColorTag: null,
        capperIsFavorite: false,
        category,
        leagueName: "MLB",
        gameId,
        gameLabel: away + " @ " + home,
        betDetail: detail,
        odds: -110,
        oddsSource: "MARKET",
        units: 1,
        status: "PENDING",
        betType,
        period: "FULL_GAME",
        rawBetDetail: detail,
        propMarket: null,
        line: betType === "MONEYLINE" ? null : 8.5,
        homeTeam: home,
        awayTeam: away,
        gameTime,
        gameStatus,
        liveState,
        teamGroup: bet === "AWAY" ? "AWAY" : "HOME",
        teamLabel: "",
        teamColor: null,
        datePosted: "2099-05-31T00:00:00.000Z",
      } as unknown as GeneratorPick;
      all.set(id, p);
      return p;
    });
    games.push({ gameId, gameLabel: away + " @ " + home, gameTime, gameStatus, ...(liveState ? { liveState } : {}), leagueName: "MLB", picks } as GeneratorGame);
  });
  return {
    builtAt: NOW.toISOString(),
    games,
    slipPicks: (opts.slip ?? []).map((id) => all.get(id)!),
    targets: opts.targets ?? [],
    leagueRecords,
    categoryRecords,
    propMarketRecords: {},
  };
}

const SETTINGS: GeneratorSettings = { legCount: 4, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "COMBINED", manualSlots: 25 };
const OFF: GeneratorSettings = { ...SETTINGS, includeLive: false };
const build = (s: GeneratorSnapshot, settings: GeneratorSettings, v: Variation | null = null) => buildGeneratedParlay(s, settings, v, NOW);
const gameOf = (id: string) => id.split("-")[0];
const generatedGames = (p: GeneratedParlay) => p.legs.filter((l) => l.source === "GENERATED").map((l) => l.pick.gameId);
const anyLive = (gameIds: string[]) => gameIds.some((g) => LIVE_GAMES.has(g));
// Every Hedge / Contrarian alternate across every Swap setting.
const swapGames = (p: GeneratedParlay) =>
  SWAP_SCOPES.flatMap((scope) => [...p.hedge[scope].legs, ...p.contrarian[scope].legs]).flatMap((l) => (l.swap ? [l.swap.pick.gameId] : []));

// ---------------------------------------------------------------------------
// The switch's own pieces
// ---------------------------------------------------------------------------
{
  check("normalize: absent is on", normalizeIncludeLive(undefined), true);
  check("normalize: true is on", normalizeIncludeLive(true), true);
  check("normalize: only literal false is off", [normalizeIncludeLive(false), normalizeIncludeLive("false"), normalizeIncludeLive(0)], [false, true, true]);
  const started = { gameTime: STARTED, gameStatus: "live" as const };
  const feedLiveFuture = { gameTime: LATER, gameStatus: "live" as const };
  check("live = scheduled start passed: off drops a started game", keepsLiveGame(false, started, NOW), false);
  check("feed says live but scheduled start is ahead: NOT live, kept with the switch off", keepsLiveGame(false, feedLiveFuture, NOW), true);
  check("a game that is over is not 'live' (it is dropped as over elsewhere)", keepsLiveGame(false, { gameTime: STARTED, gameStatus: "final" as const }, NOW), true);
  check("on keeps a started game", keepsLiveGame(true, started, NOW), true);

  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  check("store: nothing stored reads on", readStoredIncludeLive("u1", store), true);
  writeStoredIncludeLive("u1", false, store);
  check("store: off is remembered per user", [readStoredIncludeLive("u1", store), readStoredIncludeLive("u2", store)], [false, true]);
  writeStoredIncludeLive("u1", true, store);
  check("store: on clears the entry", [readStoredIncludeLive("u1", store), mem.size], [true, 0]);
  const throwing = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
  check("store: a throwing store reads on and writes nothing", readStoredIncludeLive("u1", throwing), true);
  writeStoredIncludeLive("u1", false, throwing);
  check("store: no store at all reads on", readStoredIncludeLive("u1", null), true);

  const pool = { leagues: ["MLB"], slipPickIds: [], targets: [] };
  check("run trace records the switch: on", traceSettings(pool, SETTINGS).includeLive, true);
  check("run trace records the switch: off", traceSettings(pool, OFF).includeLive, false);
}

// ---------------------------------------------------------------------------
// On (and absent) = unchanged; the fixture does put live games in the parlay.
// ---------------------------------------------------------------------------
{
  const s = makeSnapshot();
  const absent = build(s, SETTINGS);
  check("on: live games' picks are legs (the fixture means something)", anyLive(generatedGames(absent)), true);
  check("on: includeLive true builds exactly what absent builds", JSON.stringify(build(s, { ...SETTINGS, includeLive: true })), JSON.stringify(absent));
  check("on: no live targets reported", absent.liveTargets, undefined);
  const pregameOnly: GeneratorSnapshot = { ...s, games: s.games.filter((g) => !LIVE_GAMES.has(g.gameId)) };
  check("off on a slate with no started game: exactly the on build", JSON.stringify(build(pregameOnly, OFF)), JSON.stringify(build(pregameOnly, SETTINGS)));
  check("on: Hedge / Contrarian alternates do come from live games here", anyLive(swapGames(absent)), true);
}

// ---------------------------------------------------------------------------
// Off: Generate, Regenerate, Hedge / Contrarian, Swap modal
// ---------------------------------------------------------------------------
{
  const s = makeSnapshot();
  const rank = build(s, OFF);
  check("off, Generate (rank order): no generated leg from a started game", generatedGames(rank), ["G3", "G4", "G5"]);
  check("off: the parlay says how short it came (3 of 4)", rank.legs.length, 3);
  let drawLive = 0;
  let regenLive = 0;
  let swapLive = 0;
  for (let seed = 1; seed <= 200; seed++) {
    for (const mode of ["DIVERSIFIED", "EXPLORE"] as const) {
      const gen = build(s, OFF, generateVariation({ seed, mode }));
      if (anyLive(generatedGames(gen))) drawLive++;
      const regen = build(s, OFF, { seed, mode, history: [gen.historyIds] });
      if (anyLive(generatedGames(regen))) regenLive++;
      if (anyLive(swapGames(regen))) swapLive++;
    }
  }
  check("off, Generate draws (200 seeds x 2 modes): never a started game", drawLive, 0);
  check("off, Regenerate (200 seeds x 2 modes): never a started game", regenLive, 0);
  check("off, Hedge / Contrarian (every Swap setting): never an alternate from a started game", swapLive + (anyLive(swapGames(rank)) ? 1 : 0), 0);

  // The Swap modal: This game and Other games, for every leg.
  const swapRows = rank.legs.flatMap((_, i) => {
    const alt = legAlternatives(s, OFF, rank.legs, i, NOW);
    return [...alt.thisGame, ...alt.otherGames].map((o) => o.pick.gameId);
  });
  check("off, Swap modal: rows exist (the check means something)", swapRows.length > 0, true);
  check("off, Swap modal: no row from a started game", anyLive(swapRows), false);
  const onRank = build(s, SETTINGS);
  const onRows = onRank.legs.flatMap((_, i) => {
    const alt = legAlternatives(s, SETTINGS, onRank.legs, i, NOW);
    return [...alt.thisGame, ...alt.otherGames].map((o) => o.pick.gameId);
  });
  check("on, Swap modal: started games' rows are offered", anyLive(onRows), true);

  // The run trace names the drop.
  const trace = new TraceCollector({ mode: "STANDARD", trigger: "GENERATE", origin: "CLIENT", scoringVersion: "t", settings: {} });
  buildGeneratedParlay(s, OFF, null, NOW, trace);
  const t = trace.finish();
  check("off: run trace tallies FILTER_LIVE at INCLUDED (12 picks on 3 started games)", t.reasons.find((r) => r.reason === "FILTER_LIVE")?.count, 12);
}

// ---------------------------------------------------------------------------
// Slip picks are always in
// ---------------------------------------------------------------------------
{
  const s = makeSnapshot({ slip: ["G0-HOME"] });
  const off = build(s, OFF);
  check("off: a slip pick on a started game is still a leg", off.legs.some((l) => l.pick.pickId === "G0-HOME" && l.source === "SLIP"), true);
  check("off: and nothing is dropped for it", off.dropped, []);
  check("off: generated legs still avoid started games", anyLive(generatedGames(off)), false);
  check("off: the live slip leg gets no Hedge / Contrarian alternate (its game's picks are live)", anyLive(swapGames(off)), false);
}

// ---------------------------------------------------------------------------
// Targeted games
// ---------------------------------------------------------------------------
{
  const s = makeSnapshot({ targets: ["G0", "G3", "G4"] });
  const off = build(s, OFF);
  check("off: a targeted started game is skipped and reported", off.liveTargets, ["G0"]);
  check("off: ...not as unavailable (it is on the board)", off.unavailableTargets, []);
  check("off: legs only from the targeted games still in play", generatedGames(off).sort(), ["G3", "G4"]);
  check("off: no per-game shortfall line for the skipped live target (liveTargets says it)", off.shortfall.filter((l) => l.includes("Yankees")), []);
  const on = build(s, SETTINGS);
  check("on: the targeted started game is used", generatedGames(on).includes("G0"), true);
  check("on: no live targets", on.liveTargets, undefined);
  // A targeted live game that a slip pick is on: the slip pick is used, the game isn't reported.
  const withSlip = build(makeSnapshot({ targets: ["G0", "G3"], slip: ["G0-HOME"] }), OFF);
  check("off: a targeted started game holding a slip pick isn't reported skipped", withSlip.liveTargets, undefined);
  check("off: ...and its slip pick is a leg", withSlip.legs.some((l) => l.pick.pickId === "G0-HOME"), true);
}

// ---------------------------------------------------------------------------
// Feed says live, scheduled start still ahead: NOT live
// ---------------------------------------------------------------------------
{
  const s = makeSnapshot({ feedLiveButFuture: true });
  const off = build(s, OFF);
  check("off: a game the feed calls live before its scheduled start is still used", generatedGames(off).includes("G3"), true);
  check("...its picks reach the Swap modal", legAlternatives(s, OFF, off.legs, 0, NOW).otherGames.some((o) => gameOf(o.pick.pickId) === "G3") || off.legs.some((l) => l.pick.gameId === "G3"), true);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
