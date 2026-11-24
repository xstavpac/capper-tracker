// Generator settings/state fixes (one PR):
//   #2 the hand-picked pool holds up to MAX_POOL_PICKS (60) while the generated parlay stays at
//      MAX_PARLAY_LEGS (25); above 25 picks Fill from is Your picks only (the engine draws the best 25);
//   #3 Bet types / Pick Mix / Max legs per game / Fill from survive the Live round trip (the card is
//      unmounted) and the Fill from toggle, both ways;
//   #4 every league chip can be switched off; the sent picks of that league leave the slip, said once
//      ("Removed N NFL picks · Undo"), and Undo brings them and the league back;
//   #7 the Total legs stepper works right after picks are sent, in both modes; "-" at the floor is disabled
//      and says why; the range never has min above max and never rests on a stale built capacity.
// Pure logic on the helpers, then the real GeneratorCard on jsdom (real slip provider, real engine; only the
// server calls are replaced, as in generator-subset-ui-acceptance-test.ts). No DB. Run with:
//   npx tsx src/components/parlay/generator-state-fixes-acceptance-test.ts
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import { buildGeneratedParlay, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { legCapRejection, MAX_PARLAY_LEGS, MAX_POOL_PICKS, MAX_POOL_REQUEST_PICKS } from "@/lib/parlay/leg-cap";
import { EMPTY_SLIP_STATE, leagueRemovedText, restoreLeague, switchLeagueOff, togglePick, type SlipStateV2 } from "@/lib/parlay/slip-state";
import { effectiveFillFrom, floorHint, legRange, POOL_OVER_CAP_NOTE } from "@/lib/parlay/subset-ui";
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { GenerateRequest } from "@/server/actions/parlay-generate";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
const eq = (label: string, actual: unknown, expected: unknown) => check(label, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

// ---- Fixture: 60 slip picks, one moneyline per game (MLB), records 55% to 70% ------------------------
const NOW = new Date("2099-06-01T12:00:00.000Z");
const FUTURE = "2099-06-01T23:00:00.000Z";
const N = 60;
const categoryRecords: GeneratorSnapshot["categoryRecords"] = {};
const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
function pickAt(i: number, league = "MLB"): GeneratorPick {
  const id = `${league === "MLB" ? "p" : league.toLowerCase() + "-"}${i + 1}`;
  const winPct = 55 + Math.round((i * 15) / (N - 1));
  const rec = { wins: winPct, losses: 100 - winPct, pushes: 0, winPct, count: 100 };
  categoryRecords[`cap-${id}|FAV_ML`] = { key: "FAV_ML", label: "FAV_ML", ...rec };
  leagueRecords.records[`cap-${id}|${league}|FAV_ML`] = { category: "FAV_ML", label: "FAV_ML", overall: rec, league: rec };
  const home = `Home ${id}`;
  const away = `Away ${id}`;
  return {
    pickId: id, capperId: "cap-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category: "FAV_ML", leagueName: league,
    gameId: `${league}-G${i}`, gameLabel: `${away} @ ${home}`, betDetail: `${home} ML`, odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME",
    rawBetDetail: `${home} ML`, propMarket: null, line: null, homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: "", teamColor: null,
    datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}
const PICKS: GeneratorPick[] = Array.from({ length: N }, (_, i) => pickAt(i));
const NFL_PICKS: GeneratorPick[] = Array.from({ length: 3 }, (_, i) => pickAt(i, "NFL"));
const ALL = [...PICKS, ...NFL_PICKS];
const games: GeneratorGame[] = ALL.map((p) => ({ gameId: p.gameId, gameLabel: p.gameLabel, gameTime: FUTURE, leagueName: p.leagueName, picks: [p] }));
const snapshotOf = (slip: GeneratorPick[]): GeneratorSnapshot => ({ builtAt: NOW.toISOString(), games, slipPicks: slip, targets: [], leagueRecords, categoryRecords });

// ---- 1 · The pure rules --------------------------------------------------------------------------------
{
  eq("caps · pool 60, parlay 25, request bound above the pool", [MAX_POOL_PICKS, MAX_PARLAY_LEGS, MAX_POOL_REQUEST_PICKS >= MAX_POOL_PICKS], [60, 25, true]);
  eq("caps · the FanDuel/server leg cap still refuses 26 and takes 25", [legCapRejection(26) !== null, legCapRejection(25)], [true, null]);

  let s: SlipStateV2 = EMPTY_SLIP_STATE;
  for (let i = 0; i < MAX_POOL_PICKS; i++) s = togglePick(s, PICKS[i] as unknown as ExpanderPick).state;
  const over = togglePick(s, NFL_PICKS[0] as unknown as ExpanderPick);
  eq("pool · accepts 60 picks (past the old 25), refuses the 61st", [s.picks.length, over.refused, over.state.picks.length], [60, "PICK_CAP", 60]);

  eq("fill from · 0 picks: Best available", effectiveFillFrom(0, "YOUR_PICKS_ONLY"), "BEST_AVAILABLE");
  eq("fill from · 25 picks: the choice stands (both ways)", [effectiveFillFrom(25, "BEST_AVAILABLE"), effectiveFillFrom(25, "YOUR_PICKS_ONLY")], ["BEST_AVAILABLE", "YOUR_PICKS_ONLY"]);
  eq("fill from · 26+ picks: Your picks only whatever was chosen", [effectiveFillFrom(26, "BEST_AVAILABLE"), effectiveFillFrom(60, "BEST_AVAILABLE")], ["YOUR_PICKS_ONLY", "YOUR_PICKS_ONLY"]);

  // The engine, unchanged: 60 picks, Your picks only, 25 legs -> 25 legs, never more.
  const settings = { legCount: 25, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "YOUR_PICKS_ONLY" } as const;
  const parlay = buildGeneratedParlay(snapshotOf(PICKS), settings, null, NOW);
  eq("engine · 60-pick pool at 25 legs builds 25 legs from it", [parlay.legs.length, parlay.slipTotal], [25, 60]);

  // The stepper range: min never above max, max never above the parlay cap, whatever the inputs.
  let bad = 0;
  for (const yourPicksOnly of [true, false])
    for (let floor = 0; floor <= 60; floor++)
      for (let capacity = 0; capacity <= 60; capacity++) {
        const { min, max } = legRange({ yourPicksOnly, slipFloor: floor, capacity });
        if (min > max || max > MAX_PARLAY_LEGS || min < 1) bad++;
      }
  eq("range · min never exceeds max (and max never exceeds 25), every floor x capacity x mode", bad, 0);

  // The floor hint.
  eq("hint · Best available, at the floor of 7: says why", floorHint({ yourPicksOnly: false, slipFloor: 7, legCount: 7, minLegs: 7 }), "Your 7 sent picks are all included — switch to Your picks only to use fewer.");
  eq("hint · above the floor, in Your picks only, or with one pick: none", [
    floorHint({ yourPicksOnly: false, slipFloor: 7, legCount: 8, minLegs: 7 }),
    floorHint({ yourPicksOnly: true, slipFloor: 7, legCount: 1, minLegs: 1 }),
    floorHint({ yourPicksOnly: false, slipFloor: 1, legCount: 1, minLegs: 1 }),
  ], [null, null, null]);

  // League switch-off.
  const slip: SlipStateV2 = { ...EMPTY_SLIP_STATE, picks: [PICKS[0], NFL_PICKS[0], NFL_PICKS[1]] as unknown as ExpanderPick[] };
  const off = switchLeagueOff(slip, "NFL");
  eq("league off · its picks leave the slip, the league goes off, others stay", [off.state.picks.map((p) => p.pickId), off.state.excludedLeagues, off.removed.picks.length], [["p1"], ["NFL"], 2]);
  eq("league off · the line", leagueRemovedText(off.removed), "Removed 2 NFL picks");
  eq("league off · one pick is singular", leagueRemovedText(switchLeagueOff({ ...slip, picks: [NFL_PICKS[0]] as unknown as ExpanderPick[] }, "NFL").removed), "Removed 1 NFL pick");
  const back = restoreLeague(off.state, off.removed);
  eq("league off · Undo brings the picks and the league back, nothing doubled", [back.picks.map((p) => p.pickId).sort(), back.excludedLeagues], [["nfl-1", "nfl-2", "p1"], []]);
  eq("league off · Undo twice doesn't double", restoreLeague(back, off.removed).picks.length, 3);
}

// ---- 2 · The card --------------------------------------------------------------------------------------
const requests: GenerateRequest[] = [];
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-generate", {
  generateParlayAction: async (req: GenerateRequest) => {
    requests.push(req);
    const snapshot: GeneratorSnapshot = { ...snapshotOf(req.slipPickIds.map((id) => ALL.find((p) => p.pickId === id)!)), targets: req.targets.map((t) => t.gameId) };
    return { snapshot, parlay: buildGeneratedParlay(snapshot, req.settings, null, new Date()) };
  },
});
stub("../../server/actions/parlay-run-log", { recordGeneratorRunAction: async () => undefined });
stub("../../server/actions/parlay-hybrid", { hybridGenerateAction: async () => ({}), hybridFanDuelLinkAction: async () => ({ error: "not used here" }) });
stub("../../server/actions/picks", { getLeagueRecordsAction: async () => ({ records: {}, streaks: {}, last20: {} }) });
stub("../../server/actions/parlay-slip", {
  getSlipPickStatesAction: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, over: false, gameStatus: null }])),
});

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/parlay" });
  const win = dom.window;
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.self = win;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { ParlayPoolProvider, useParlayPool } = await import("./parlay-pool-context");
  const { GeneratorCard } = await import("./generator-card");
  const h = React.createElement;
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const settle = async () => {
    for (let i = 0; i < 4; i++) await act(async () => void (await tick()));
  };
  const router = { push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {}, forward: () => {} };

  let ctx!: ReturnType<typeof useParlayPool>;
  function Probe() {
    ctx = useParlayPool();
    return null;
  }
  const el = win.document.createElement("div");
  win.document.body.appendChild(el);
  const text = () => el.textContent ?? "";
  const buttons = () => Array.from(el.querySelectorAll("button"));
  const button = (label: string) => buttons().find((b) => (b.textContent ?? "").trim() === label || b.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;
  const click = async (b: Element | undefined | null) => {
    if (!b) throw new Error("no such control");
    await act(() => void (b as HTMLElement).click());
    await settle();
  };
  const waitUntil = async (cond: () => boolean, what: string, timeoutMs = 10_000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out after " + timeoutMs + "ms waiting for " + what);
      await act(async () => void (await tick()));
    }
  };
  const generate = async () => {
    await click(button("Generate parlay"));
    await waitUntil(() => !text().includes("Generating…"), "Generating… to clear");
  };
  const fillFrom = (label: "Best available" | "Combined" | "Your picks only") =>
    Array.from(el.querySelectorAll('[role="radiogroup"][aria-label="Fill from"] [role="radio"]')).find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
  const betType = (label: string) => Array.from(el.querySelectorAll('[role="group"][aria-label="Bet types"] button')).find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
  const legsShown = () => button("More legs")?.previousElementSibling?.textContent;
  const legItems = () => el.querySelectorAll("ol > li").length;

  let root: Root | null = null;
  async function mount(userId: string, withCard = true) {
    if (!root) root = createRoot(el);
    await act(() =>
      root!.render(h(AppRouterContext.Provider, { value: router as never }, h(ParlayPoolProvider, { userId, children: null }, h(Probe), withCard ? h(GeneratorCard, { leagues: ["MLB", "NFL"] }) : null)))
    );
    await settle();
  }
  const store = (userId: string, picks: GeneratorPick[], legCount = 3) =>
    win.localStorage.setItem("parlay-pool:" + userId, JSON.stringify({ version: 2, picks: picks as unknown as ExpanderPick[], targets: [], excludedLeagues: [], legacy: { legCount } }));

  // ---- #2 · A 60-pick pool, a 25-leg parlay ------------------------------------------------------------
  store("u1", PICKS);
  await mount("u1");
  check("#2 · the pool holds 60 picks", ctx.pool.length === 60, `pool=${ctx.pool.length}`);
  // Over the cap: Combined (the default with picks) or Your picks only - never Best available (every pick in).
  check("#2 · Fill from is Combined (the default), Best available is disabled", fillFrom("Combined")?.getAttribute("aria-checked") === "true" && fillFrom("Best available")?.disabled === true);
  await click(fillFrom("Your picks only"));
  check("#2 · Your picks only can be chosen", fillFrom("Your picks only")?.getAttribute("aria-checked") === "true");
  check("#2 · the note says the generator picks the best 25", text().includes(POOL_OVER_CAP_NOTE), POOL_OVER_CAP_NOTE);
  await click(fillFrom("Best available"));
  check("#2 · tapping Best available changes nothing", fillFrom("Your picks only")?.getAttribute("aria-checked") === "true" && ctx.generatorFilters.fillFrom !== "BEST_AVAILABLE" || ctx.generatorFilters.fillFrom === "BEST_AVAILABLE" && fillFrom("Your picks only")?.getAttribute("aria-checked") === "true");
  for (let i = 0; i < 40; i++) await click(button("More legs"));
  check("#2 · the stepper stops at 25 (the parlay cap), not 60", ctx.legCount === MAX_PARLAY_LEGS, `legs=${ctx.legCount}`);
  await generate();
  const sent = requests[requests.length - 1];
  check("#2 · the request names all 60 picks, Your picks only, 25 legs", sent.slipPickIds.length === 60 && sent.settings.fillFrom === "YOUR_PICKS_ONLY" && sent.settings.legCount === 25, JSON.stringify({ n: sent.slipPickIds.length, f: sent.settings.fillFrom, l: sent.settings.legCount }));
  check("#2 · the parlay has 25 legs, never more", legItems() === 25 && text().includes("25 of your 60 picks used"), `legs=${legItems()}`);
  await act(() => ctx.clearSlip());
  await settle();

  // ---- #7 · Stepper right after sending picks (Best available, then Your picks only) --------------------
  await mount("u2");
  await act(() => ctx.setLegCount(3));
  await act(() => ctx.enterSlipMode());
  for (const p of PICKS.slice(0, 5)) await act(() => ctx.togglePick(p as unknown as ExpanderPick));
  await act(() => ctx.sendToGenerator());
  await settle();
  // The first picks make Combined the default (combined-fill.ts); this check is Best available's floor.
  check("#7 · the first picks make Combined the default", fillFrom("Combined")?.getAttribute("aria-checked") === "true" && ctx.legCount === 3, `legs=${ctx.legCount}`);
  await click(fillFrom("Best available"));
  const floor = ctx.legCount;
  check("#7 · Best available: the 5 sent picks set the floor", floor === 5 && legsShown() === "5", `legs=${ctx.legCount} shown=${legsShown()}`);
  check("#7 · Best available: More legs is usable right away", button("More legs")?.disabled === false);
  await click(button("More legs"));
  check("#7 · ...and raises the count", ctx.legCount === 6 && legsShown() === "6", `legs=${ctx.legCount}`);
  await click(button("Fewer legs"));
  check("#7 · at the floor: Fewer legs is disabled, not a silent no-op", ctx.legCount === 5 && button("Fewer legs")?.disabled === true);
  check("#7 · ...and the hint says why", text().includes("Your 5 sent picks are all included — switch to Your picks only to use fewer."));
  await click(button("More legs"));
  check("#7 · above the floor the hint is gone", !text().includes("sent picks are all included"));
  await click(fillFrom("Your picks only"));
  check("#7 · Your picks only: Fewer legs works right away, no hint", button("Fewer legs")?.disabled === false && !text().includes("sent picks are all included"));
  for (let i = 0; i < 8; i++) await click(button("Fewer legs"));
  check("#7 · Your picks only: down to 1", ctx.legCount === 1 && button("Fewer legs")?.disabled === true, `legs=${ctx.legCount}`);

  // Not a stale built capacity: build under Your picks only (capacity = the 5 picks), then Best available.
  for (let i = 0; i < 4; i++) await click(button("More legs"));
  await generate();
  check("#7 · built under Your picks only: the stepper is bounded by those 5 picks", button("More legs")?.disabled === true && ctx.legCount === 5, `legs=${ctx.legCount}`);
  await click(fillFrom("Best available"));
  await settle();
  check("#7 · back to Best available: the ceiling is recomputed, More legs works", button("More legs")?.disabled === false, `legs=${ctx.legCount}`);
  await click(button("More legs"));
  check("#7 · ...and raises the count past the 5 picks", ctx.legCount === 6, `legs=${ctx.legCount}`);
  await act(() => ctx.clearSlip());
  await settle();

  // ---- #3 · Filters survive the Fill from toggle, both ways, and the trip to Live and back -------------
  await mount("u3");
  await act(() => ctx.setLegCount(3));
  await act(() => ctx.enterSlipMode());
  for (const p of PICKS.slice(0, 4)) await act(() => ctx.togglePick(p as unknown as ExpanderPick));
  await act(() => ctx.sendToGenerator());
  await settle();
  await click(betType("Props"));
  await click(button("More: Max legs per game"));
  const includeNow = () => JSON.stringify(ctx.generatorFilters.include);
  check("#3 · Bet types = Props set", includeNow() === '["PROPS"]' && betType("Props")?.getAttribute("aria-pressed") === "true");
  await click(fillFrom("Your picks only"));
  check("#3 · Your picks only: the filters are kept (dimmed, not reset)", includeNow() === '["PROPS"]' && ctx.generatorFilters.maxPerGame === 2, includeNow());
  await click(fillFrom("Best available"));
  check("#3 · ...and back on Best available they are still Props and 2 per game", includeNow() === '["PROPS"]' && ctx.generatorFilters.maxPerGame === 2 && betType("Props")?.getAttribute("aria-pressed") === "true" && betType("All Picks")?.getAttribute("aria-pressed") === "false");
  await generate();
  const best = requests[requests.length - 1];
  check("#3 · Best available builds with Props only (not everything)", JSON.stringify(best.settings.include) === '["PROPS"]' && best.settings.fillFrom === "BEST_AVAILABLE" && best.settings.maxLegsPerGame === 2, JSON.stringify(best.settings));
  // The trip to Live: the card is unmounted, the slip provider is not.
  await mount("u3", false);
  check("#3 · the card is gone (Live)", buttons().length === 0);
  await mount("u3", true);
  check("#3 · back on /parlay the filters are still set", betType("Props")?.getAttribute("aria-pressed") === "true" && ctx.generatorFilters.maxPerGame === 2 && fillFrom("Best available")?.getAttribute("aria-checked") === "true", includeNow());
  await act(() => ctx.clearSlip());
  await settle();

  // ---- #4 · Every league chip can be switched off, with the picks removed and an Undo ------------------
  store("u4", [...PICKS.slice(0, 4), ...NFL_PICKS]);
  await mount("u4");
  const chip = (league: string) => Array.from(el.querySelectorAll('[role="switch"]')).find((b) => (b.textContent ?? "").trim().startsWith(league)) as HTMLButtonElement | undefined;
  check("#4 · NFL has sent picks and is on", ctx.isLeagueInScope("NFL") && ctx.pool.length === 7, `pool=${ctx.pool.length}`);
  await click(chip("NFL"));
  check("#4 · NFL switches off (not frozen)", !ctx.isLeagueInScope("NFL") && chip("NFL")?.getAttribute("aria-checked") === "false");
  check("#4 · its 3 sent picks left the slip, MLB's stay", ctx.pool.length === 4 && ctx.pool.every((p) => p.leagueName === "MLB"));
  check("#4 · 'Removed 3 NFL picks · Undo'", text().includes("Removed 3 NFL picks · Undo"));
  // The Undo on the "Removed ..." line (an earlier scenario's "Cleared N picks" Undo may still be on screen).
  await click(Array.from(el.querySelectorAll("p")).find((p) => (p.textContent ?? "").includes("Removed 3 NFL picks"))?.querySelector("button"));
  check("#4 · Undo brings the 3 picks and NFL back", ctx.pool.length === 7 && ctx.isLeagueInScope("NFL") && !text().includes("Removed 3 NFL picks"), `pool=${ctx.pool.length}`);
  for (const league of ["MLB", "NFL"]) {
    await click(chip(league));
    check(`#4 · ${league} can be switched off`, chip(league)?.getAttribute("aria-checked") === "false");
  }

  root!.unmount();
  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
