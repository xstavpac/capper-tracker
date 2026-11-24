// Live prices for the -250 leg price floor (live-price.ts, server/data/live-prices.ts, price-floor.ts). Pure - no
// DB, the Odds API mocked, the shared cache an in-memory stand-in with a fake clock.
//   npx tsx src/lib/parlay/live-price-acceptance-test.ts
//
// The bug: the floor read the posted price only, so a -150 pick on a game that swung to -850 in-play passed it.
//   - posted -150 / live -850 generated leg: excluded from Generate, Regenerate (200 seeds), Hedge / Contrarian
//     and every Swap modal row;
//   - posted -300 / live -200: allowed;
//   - a no-price (DEFAULTED) pick with a live price is capped on the live price;
//   - a slip pick at -850 live: still a leg;
//   - pregame picks: unchanged (no live price, posted price judged as before).
// The call: switch off -> none; pregame-only pool -> none; started games -> one per league, a second build within
// 60 s reuses it, after 60 s a new one; a failure -> posted prices, the build completes, FAILED recorded and not cached.
import { buildGeneratedParlay, generateVariation, legAlternatives, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GameLiveState } from "@/lib/parlay/game-progress";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { currentOdds, leaguesNeedingLivePrices, livePriceFor, withLivePrices, type LiveListingGame } from "@/lib/parlay/live-price";
import { belowPriceFloor } from "@/lib/parlay/price-floor";
import { priceStartedGames, trimLiveListing, type LivePriceDeps } from "@/server/data/live-prices";
import { SWAP_SCOPES } from "@/lib/parlay/swap-scope";
import { TraceCollector } from "@/lib/parlay/run-trace";
import { createGeneratorSession } from "@/lib/parlay/generator-session";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const NOW = new Date("2099-01-10T01:30:00.000Z");
const STARTED = "2099-01-10T00:30:00.000Z";
const LATER = "2099-01-10T03:00:00.000Z";
const Q2: GameLiveState = { period: 2, clock: "5:00", inningHalf: null, inning: null, away: 40, home: 60, scoreMissing: false };

type Spec = { id: string; game: string; league: "NBA" | "NHL"; bet: "HOME" | "AWAY" | "OVER"; odds: number; win: number; source?: "MARKET" | "DEFAULTED" };
const GAMES: Record<string, { home: string; away: string; live: boolean; league: "NBA" | "NHL" }> = {
  A: { home: "Indiana Pacers", away: "Oklahoma City Thunder", live: true, league: "NBA" },
  B: { home: "Charlotte Hornets", away: "Memphis Grizzlies", live: true, league: "NBA" },
  C: { home: "Los Angeles Lakers", away: "Utah Jazz", live: false, league: "NBA" },
  D: { home: "Sacramento Kings", away: "San Antonio Spurs", live: false, league: "NBA" },
  E: { home: "New York Islanders", away: "Toronto Maple Leafs", live: true, league: "NHL" },
  F: { home: "Sacramento Kings2", away: "Phoenix Suns", live: false, league: "NBA" },
};
// A's posted -150 is the strongest pick on the slate: with the posted price it is the first leg.
const SPECS: Spec[] = [
  { id: "a-okc", game: "A", league: "NBA", bet: "AWAY", odds: -150, win: 80 }, // live -850
  { id: "a-over", game: "A", league: "NBA", bet: "OVER", odds: -110, win: 62 }, // live -110 (a Hedge candidate on A)
  { id: "b-mem", game: "B", league: "NBA", bet: "AWAY", odds: -300, win: 79 }, // live -200: allowed now
  { id: "b-cha", game: "B", league: "NBA", bet: "HOME", odds: -110, win: 61, source: "DEFAULTED" }, // no price, live -900
  { id: "c-lal", game: "C", league: "NBA", bet: "HOME", odds: -140, win: 70 },
  { id: "d-sac", game: "D", league: "NBA", bet: "HOME", odds: -120, win: 68 },
  { id: "e-nyi", game: "E", league: "NHL", bet: "HOME", odds: -160, win: 66 }, // live -1000
  { id: "f-phx", game: "F", league: "NBA", bet: "AWAY", odds: 120, win: 64 },
];
const LIVE: Record<string, number> = { "a-okc": -850, "a-over": -110, "b-mem": -200, "b-cha": -900, "e-nyi": -1000 };

function makeSnapshot(slip: string[] = []): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const byGame = new Map<string, GeneratorPick[]>();
  const all = new Map<string, GeneratorPick>();
  for (const s of SPECS) {
    const g = GAMES[s.game];
    const category: PickCategoryKey = s.bet === "OVER" ? "OVER" : s.odds < 0 ? "FAV_ML" : "DOG_ML";
    const capperId = "cap-" + s.id;
    const losses = 100 - s.win;
    categoryRecords[capperId + "|" + category] = { key: category, label: category, wins: s.win, losses, pushes: 0, winPct: s.win, count: 100 };
    leagueRecords.records[capperId + "|" + s.league + "|" + category] = {
      category,
      label: category,
      overall: { wins: s.win, losses, pushes: 0, winPct: s.win, count: 100 },
      league: { wins: s.win, losses, pushes: 0, winPct: s.win, count: 100 },
    };
    const detail = s.bet === "OVER" ? "Over 225.5" : (s.bet === "HOME" ? g.home : g.away) + " ML";
    const p = {
      pickId: s.id,
      capperId,
      capperName: "Capper " + s.id,
      capperColorTag: null,
      capperIsFavorite: false,
      category,
      leagueName: s.league,
      gameId: s.game,
      gameLabel: g.away + " @ " + g.home,
      betDetail: detail,
      odds: s.odds,
      oddsSource: s.source ?? "MARKET",
      units: 1,
      status: "PENDING",
      betType: s.bet === "OVER" ? "TOTAL" : "MONEYLINE",
      period: "FULL_GAME",
      rawBetDetail: detail,
      propMarket: null,
      line: s.bet === "OVER" ? 225.5 : null,
      homeTeam: g.home,
      awayTeam: g.away,
      gameTime: g.live ? STARTED : LATER,
      gameStatus: g.live ? "live" : "preview",
      liveState: g.live ? Q2 : null,
      teamGroup: s.bet === "OVER" ? "TOTALS" : s.bet,
      teamLabel: "",
      teamColor: null,
      datePosted: "2099-01-09T00:00:00.000Z",
    } as unknown as GeneratorPick;
    all.set(s.id, p);
    byGame.set(s.game, [...(byGame.get(s.game) ?? []), p]);
  }
  const games: GeneratorGame[] = Array.from(byGame.entries()).map(([id, picks]) => {
    const g = GAMES[id];
    return { gameId: id, gameLabel: g.away + " @ " + g.home, gameTime: g.live ? STARTED : LATER, gameStatus: g.live ? "live" : "preview", ...(g.live ? { liveState: Q2 } : {}), leagueName: g.league, picks } as GeneratorGame;
  });
  return { builtAt: NOW.toISOString(), games, slipPicks: slip.map((id) => all.get(id)!), targets: [], leagueRecords, categoryRecords, propMarketRecords: {} };
}

// The listing FanDuel would give: each live game's markets at the LIVE prices.
function listingFor(league: "NBA" | "NHL"): LiveListingGame[] {
  return Object.entries(GAMES)
    .filter(([, g]) => g.live && g.league === league)
    .map(([id, g]) => {
      const specs = SPECS.filter((s) => s.game === id);
      const h2h = specs.filter((s) => s.bet !== "OVER").map((s) => ({ name: s.bet === "HOME" ? g.home : g.away, price: LIVE[s.id] }));
      const totals = specs.filter((s) => s.bet === "OVER").map((s) => ({ name: "Over", price: LIVE[s.id], point: 225.5 }));
      return { id, homeTeam: g.home, awayTeam: g.away, markets: [{ key: "h2h", outcomes: h2h }, ...(totals.length ? [{ key: "totals", outcomes: totals }] : [])] };
    });
}

const SETTINGS: GeneratorSettings = { legCount: 4, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const priced = (s: GeneratorSnapshot) => {
  const r = withLivePrices(s.games, s.slipPicks, new Map([["NBA", listingFor("NBA")], ["NHL", listingFor("NHL")]]), NOW);
  return { ...s, games: r.games, slipPicks: r.slipPicks, livePricing: { asked: true, leagues: { NBA: "FETCHED" as const, NHL: "FETCHED" as const } } };
};
const legIds = (p: GeneratedParlay) => p.legs.map((l) => l.pick.pickId);
const altIds = (p: GeneratedParlay) => SWAP_SCOPES.flatMap((sc) => [...p.hedge[sc].legs, ...p.contrarian[sc].legs]).flatMap((l) => (l.swap ? [l.swap.pick.pickId] : []));
const CAPPED = ["a-okc", "b-cha", "e-nyi"];

// ---------------------------------------------------------------------------
// Matching and the current-price rule
// ---------------------------------------------------------------------------
{
  const s = priced(makeSnapshot());
  const pick = (id: string) => s.games.flatMap((g) => g.picks).find((p) => p.pickId === id)!;
  check("live ML matched by the pick's side: OKC (away) -850", pick("a-okc").liveOdds, -850);
  check("live total matched at the pick's own line: Over 225.5 -110", pick("a-over").liveOdds, -110);
  check("pregame pick: no live price", pick("c-lal").liveOdds, undefined);
  const g = listingFor("NBA")[0];
  check("a total at another line has no live price", livePriceFor({ betType: "TOTAL", period: "FULL_GAME", teamGroup: "TOTALS", line: 230.5, betDetail: "Over 230.5" }, g), null);
  check("a first-half pick has no live price", livePriceFor({ betType: "MONEYLINE", period: "FIRST_HALF", teamGroup: "AWAY", line: null, betDetail: "OKC 1H ML" }, g), null);
  check("a prop has no live price (keeps posted + label)", livePriceFor({ betType: "PLAYER_PROP", period: "FULL_GAME", teamGroup: "OTHER", line: 25.5, betDetail: "SGA Over 25.5 points" }, g), null);
  check("current price: live when there is one", [currentOdds({ odds: -150, liveOdds: -850 }), currentOdds({ odds: -150 })], [-850, -150]);
  check("floor: posted -150 / live -850 -> capped", belowPriceFloor({ betType: "MONEYLINE", odds: -150, oddsSource: "MARKET", liveOdds: -850 }), true);
  check("floor: posted -300 / live -200 -> allowed", belowPriceFloor({ betType: "MONEYLINE", odds: -300, oddsSource: "MARKET", liveOdds: -200 }), false);
  check("floor: no posted price, live -900 -> capped on the live price", belowPriceFloor({ betType: "MONEYLINE", odds: -110, oddsSource: "DEFAULTED", liveOdds: -900 }), true);
  check("floor: pregame unchanged (posted -300 capped, -110 DEFAULTED not)", [belowPriceFloor({ betType: "MONEYLINE", odds: -300, oddsSource: "MARKET" }), belowPriceFloor({ betType: "MONEYLINE", odds: -110, oddsSource: "DEFAULTED" })], [true, false]);
  check("leagues: off -> none", leaguesNeedingLivePrices(s.games, false, NOW), []);
  check("leagues: on -> each league with a started game", leaguesNeedingLivePrices(s.games, true, NOW), ["NBA", "NHL"]);
  check("leagues: a game the feed calls live before its scheduled start is not started", leaguesNeedingLivePrices([{ gameId: "x", leagueName: "NBA", gameTime: LATER, gameStatus: "live" }], true, NOW), []);
  check(
    "trimmed listing: in-play FanDuel events only, three markets",
    trimLiveListing(
      [
        { id: "x", home_team: "H", away_team: "A", commence_time: STARTED, bookmakers: [{ key: "fanduel", markets: [{ key: "h2h", outcomes: [{ name: "H", price: -400 }] }, { key: "player_points", outcomes: [] }] }] },
        { id: "y", home_team: "H2", away_team: "A2", commence_time: LATER, bookmakers: [{ key: "fanduel", markets: [] }] },
        { id: "z", home_team: "H3", away_team: "A3", commence_time: STARTED, bookmakers: [{ key: "draftkings", markets: [] }] },
      ],
      NOW
    ),
    [{ id: "x", homeTeam: "H", awayTeam: "A", markets: [{ key: "h2h", outcomes: [{ name: "H", price: -400 }] }] }]
  );
}

// ---------------------------------------------------------------------------
// The cap in every path: Generate, Regenerate, Hedge / Contrarian, Swap modal
// ---------------------------------------------------------------------------
{
  const posted = makeSnapshot();
  const before = buildGeneratedParlay(posted, SETTINGS, null, NOW);
  check("the bug, before: posted -150 OKC (live -850) is a leg on the posted price", legIds(before).includes("a-okc"), true);
  check("...and posted -300 Memphis is capped on its posted price", legIds(before).includes("b-mem"), false);

  const s = priced(posted);
  const rank = buildGeneratedParlay(s, SETTINGS, null, NOW);
  check("Generate (rank order): no leg whose current price is shorter than -250", legIds(rank).filter((id) => CAPPED.includes(id)), []);
  check("posted -300 / live -200 Memphis is now allowed (and taken)", legIds(rank).includes("b-mem"), true);
  let gen = 0;
  let regen = 0;
  let alts = 0;
  for (let seed = 1; seed <= 200; seed++) {
    for (const mode of ["BEST", "DIVERSIFIED", "EXPLORE"] as const) {
      const g = buildGeneratedParlay(s, SETTINGS, generateVariation({ seed, mode }), NOW);
      gen += legIds(g).filter((id) => CAPPED.includes(id)).length;
      const r = buildGeneratedParlay(s, SETTINGS, { seed, mode, history: [g.historyIds] }, NOW);
      regen += legIds(r).filter((id) => CAPPED.includes(id)).length;
      alts += altIds(g).concat(altIds(r)).filter((id) => CAPPED.includes(id)).length;
    }
  }
  check("Generate draws (200 seeds x 3 modes): never a capped leg", gen, 0);
  check("Regenerate (200 seeds x 3 modes): never a capped leg", regen, 0);
  check("Hedge / Contrarian (every Swap setting): never a capped alternate", alts, 0);
  const rows = rank.legs.flatMap((_, i) => {
    const a = legAlternatives(s, SETTINGS, rank.legs, i, NOW);
    return [...a.thisGame, ...a.otherGames].map((o) => o.pick.pickId);
  });
  check("Swap modal (This game / Other games / below the gate): rows exist", rows.length > 0, true);
  check("Swap modal: never a capped pick", rows.filter((id) => CAPPED.includes(id)), []);
  check("a capped live leg is shown nowhere at its posted price either (no leg carries posted -150 OKC)", rank.legs.some((l) => l.pick.pickId === "a-okc"), false);
  const memLeg = rank.legs.find((l) => l.pick.pickId === "b-mem")!;
  check("the leg carries its live price for the card and the combined odds", [memLeg.pick.odds, memLeg.pick.liveOdds, currentOdds(memLeg.pick)], [-300, -200, -200]);

  const trace = new TraceCollector({ mode: "STANDARD", trigger: "GENERATE", origin: "SERVER", scoringVersion: "t", settings: {} });
  buildGeneratedParlay(s, SETTINGS, null, NOW, trace);
  const t = trace.finish();
  check("run trace: PRICE_FLOOR counts the three live-capped picks", t.reasons.filter((r) => r.reason === "PRICE_FLOOR").map((r) => r.sub).sort(), ["-1000 live", "-850 live", "-900 live"]);
  check("run trace: each league's live-price status and the count priced", (t.extras.notes ?? []).filter((n) => n.startsWith("livePrice")), ["livePrices:NBA=FETCHED", "livePrices:NHL=FETCHED", "livePriced:5"]);
}

// ---------------------------------------------------------------------------
// Slip picks stay exempt
// ---------------------------------------------------------------------------
{
  const s = priced(makeSnapshot(["e-nyi"]));
  const p = buildGeneratedParlay(s, SETTINGS, null, NOW);
  const leg = p.legs.find((l) => l.pick.pickId === "e-nyi");
  check("a slip pick at -1000 live is still a leg", leg?.source, "SLIP");
  check("...shown at its live price", leg ? currentOdds(leg.pick) : null, -1000);
}

// ---------------------------------------------------------------------------
// The call: when it happens, the shared 60 s cache, failure
// ---------------------------------------------------------------------------
async function calls() {
  let clock = NOW.getTime();
  const store = new Map<string, { at: number; value: unknown }>();
  const asked: string[] = [];
  let failNext = false;
  const deps: LivePriceDeps = {
    fetchListing: async (sportKey) => {
      asked.push(sportKey);
      if (failNext) throw new Error("HTTP 500");
      return listingFor(sportKey === "basketball_nba" ? "NBA" : "NHL");
    },
    cached: async <T,>(key: string, ttl: number, fn: () => Promise<T>) => {
      const hit = store.get(key);
      if (hit && clock - hit.at < ttl * 1000) return hit.value as T;
      const value = await fn();
      store.set(key, { at: clock, value });
      return value;
    },
  };
  const KEYS: Record<string, string> = { NBA: "basketball_nba", NHL: "icehockey_nhl" };
  const run = (s: GeneratorSnapshot, includeLive: boolean) =>
    priceStartedGames({ games: s.games, slipPicks: s.slipPicks, includeLive, sportKeyOf: (l) => KEYS[l] }, new Date(clock), deps);

  const s = makeSnapshot();
  const off = await run(s, false);
  check("switch off: no call", asked.length, 0);
  check("switch off: recorded as not asked, no live price", [off.livePricing, off.priced], [{ asked: false, leagues: {} }, 0]);

  const pregame: GeneratorSnapshot = { ...s, games: s.games.filter((g) => !GAMES[g.gameId].live) };
  const pre = await run(pregame, true);
  check("pregame-only pool: no call", asked.length, 0);
  check("pregame-only pool: asked, nothing needed", pre.livePricing, { asked: true, leagues: {} });

  const first = await run(s, true);
  check("started games: one call per league", asked.slice().sort(), ["basketball_nba", "icehockey_nhl"]);
  check("...both FETCHED, five picks priced", [first.livePricing.leagues, first.priced], [{ NBA: "FETCHED", NHL: "FETCHED" }, 5]);
  clock += 59_000;
  await run(s, true);
  check("a second build within 60 s reuses the shared cache: no new call", asked.length, 2);
  clock += 2_000;
  await run(s, true);
  check("after 60 s: one new call per league", asked.length, 4);

  clock += 61_000;
  failNext = true;
  const failed = await run(s, true);
  check("API failure: FAILED recorded per league", failed.livePricing.leagues, { NBA: "FAILED", NHL: "FAILED" });
  check("API failure: posted prices kept", [failed.priced, failed.games.flatMap((g) => g.picks).some((p) => p.liveOdds != null)], [0, false]);
  const built = buildGeneratedParlay({ ...s, games: failed.games, slipPicks: failed.slipPicks, livePricing: failed.livePricing }, SETTINGS, null, new Date(clock));
  check("API failure: the build completes, on posted prices (OKC -150 a leg again)", [built.legs.length, legIds(built).includes("a-okc")], [4, true]);
  failNext = false;
  await run(s, true);
  check("a failure is not cached: the next build calls again", asked.length, 8);
}

// The session: a snapshot loaded with the switch off holds no live prices, so turning it on reloads once -
// only when the snapshot has a started game; one loaded with it on is reused either way.
async function session() {
  let requests = 0;
  const offSnap = { ...makeSnapshot(), livePricing: { asked: false, leagues: {} } };
  const sess = createGeneratorSession({
    now: () => NOW,
    firstSeed: 7,
    generate: async (req) => {
      requests++;
      const snapshot = req.settings.includeLive === false ? offSnap : priced(makeSnapshot());
      return { snapshot, parlay: buildGeneratedParlay(snapshot, req.settings, null, NOW) };
    },
  });
  const inputs = { leagues: ["NBA", "NHL"], slipPickIds: [], targets: [] };
  await sess.generate(inputs, { ...SETTINGS, includeLive: false });
  await sess.regenerate(inputs, { ...SETTINGS, includeLive: false });
  check("session: switch off, Regenerate reuses the snapshot", requests, 1);
  await sess.generate(inputs, SETTINGS);
  check("session: switch turned on after an off snapshot with started games -> one reload", requests, 2);
  await sess.regenerate(inputs, SETTINGS);
  await sess.generate(inputs, { ...SETTINGS, includeLive: false });
  check("session: a snapshot loaded with it on is reused (on or off)", requests, 2);
}

Promise.all([calls(), session()]).then(() => {
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
});
