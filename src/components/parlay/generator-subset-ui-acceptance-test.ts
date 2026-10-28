// Fill from = Your picks only, in the UI (subset-ui.ts; generator-card.tsx and
// generator-result.tsx on top of the engine's rule 6, PR #370). Two halves:
//   1. The pure rules: the Total legs range and note in both modes, the result's
//      summary line (subset / all in / Best available), the collapsed unused-picks
//      line and the Regenerate messages and disabled state - on parlays built by
//      the real engine.
//   2. The real GeneratorCard on jsdom (real slip provider, real engine; only the
//      server calls are replaced, as in generator-card-acceptance-test.ts): 20
//      picks, the stepper going down to 7 and to 1 with no forced push, a 7-leg
//      parlay that says "7 of your 20 picks used", "13 picks not used this time"
//      opening to the list, Regenerate giving another 7 with no request, and 6
//      picks at 6 legs with Regenerate disabled.
// Pure - no DB. Run with:
//   npx tsx src/components/parlay/generator-subset-ui-acceptance-test.ts
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import { buildGeneratedParlay, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import { ALL_PICKS_IN, legRange, legsNote, nothingToVary, NO_COMPARABLE, pickSummary, regenerateState, unusedLine, unusedPicks } from "@/lib/parlay/subset-ui";
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { GenerateRequest } from "@/server/actions/parlay-generate";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
const eq = (label: string, actual: unknown, expected: unknown) => check(label, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

// ---- Fixture: 20 slip picks, one moneyline per game, records 55% to 70% -------------------------
const NOW = new Date("2099-06-01T12:00:00.000Z");
const FUTURE = "2099-06-01T23:00:00.000Z";
const categoryRecords: GeneratorSnapshot["categoryRecords"] = {};
const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
const PICKS: GeneratorPick[] = Array.from({ length: 20 }, (_, i) => {
  const id = `p${i + 1}`;
  const winPct = 55 + Math.round((i * 15) / 19);
  const rec = { wins: winPct, losses: 100 - winPct, pushes: 0, winPct, count: 100 };
  categoryRecords[`cap-${id}|FAV_ML`] = { key: "FAV_ML", label: "FAV_ML", ...rec };
  leagueRecords.records[`cap-${id}|MLB|FAV_ML`] = { category: "FAV_ML", label: "FAV_ML", overall: rec, league: rec };
  const home = `Home ${id}`;
  const away = `Away ${id}`;
  return {
    pickId: id, capperId: "cap-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category: "FAV_ML", leagueName: "MLB",
    gameId: "G" + i, gameLabel: `${away} @ ${home}`, betDetail: `${home} ML`, odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME",
    rawBetDetail: `${home} ML`, propMarket: null, line: null, homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: "", teamColor: null,
    datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
});
const games: GeneratorGame[] = PICKS.map((p) => ({ gameId: p.gameId, gameLabel: p.gameLabel, gameTime: FUTURE, leagueName: "MLB", picks: [p] }));
const snapshotOf = (slip: GeneratorPick[]): GeneratorSnapshot => ({ builtAt: NOW.toISOString(), games, slipPicks: slip, targets: [], leagueRecords, categoryRecords });
const settingsOf = (legCount: number, fillFrom: GeneratorSettings["fillFrom"]): GeneratorSettings => ({ legCount, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom });
const build = (slip: GeneratorPick[], legCount: number, fillFrom: GeneratorSettings["fillFrom"]): GeneratedParlay =>
  buildGeneratedParlay(snapshotOf(slip), settingsOf(legCount, fillFrom), null, NOW);

// ---- 1 · The pure rules --------------------------------------------------------------------------
{
  const subset = build(PICKS, 7, "YOUR_PICKS_ONLY");
  const allIn = build(PICKS.slice(0, 6), 6, "YOUR_PICKS_ONLY");
  const best = build(PICKS.slice(0, 6), 8, "BEST_AVAILABLE");

  eq("engine: 7 of 20 picks, 13 not_selected", [subset.legs.length, subset.slipUsed, subset.slipTotal, unusedPicks(subset).length, subset.capacity], [7, 7, 20, 13, 20]);

  // Total legs range
  eq("range · Your picks only, 20 picks, built (capacity 20): 1 to 20", legRange({ yourPicksOnly: true, slipFloor: 20, capacity: subset.capacity }), { min: 1, max: 20 });
  eq("range · Your picks only, not built yet: 1 to the cap", legRange({ yourPicksOnly: true, slipFloor: 20, capacity: MAX_PARLAY_LEGS }), { min: 1, max: MAX_PARLAY_LEGS });
  eq("range · Your picks only, 6 picks: 1 to 6", legRange({ yourPicksOnly: true, slipFloor: 6, capacity: allIn.capacity }), { min: 1, max: 6 });
  eq("range · Best available, 20 picks: never fewer than the 20 (the old rule)", legRange({ yourPicksOnly: false, slipFloor: 20, capacity: MAX_PARLAY_LEGS }), { min: 20, max: MAX_PARLAY_LEGS });
  eq("range · Best available, 6 picks, built: 6 to the engine's capacity", legRange({ yourPicksOnly: false, slipFloor: 6, capacity: best.capacity }), { min: 6, max: best.capacity });
  eq("range · Best available, no picks: from 1", legRange({ yourPicksOnly: false, slipFloor: 0, capacity: MAX_PARLAY_LEGS }), { min: 1, max: MAX_PARLAY_LEGS });

  // Total legs note
  eq("note · subset: 7 of your 20 picks", legsNote({ yourPicksOnly: true, legCount: 7, slipFloor: 20, generatedLegs: 0, usable: 20, total: 20 }), "Up to 25 · 7 of your 20 picks.");
  eq("note · Your picks only, legs reach the picks: all of them", legsNote({ yourPicksOnly: true, legCount: 9, slipFloor: 6, generatedLegs: 3, usable: 6, total: 6 }), "Up to 25 · all 6 of your picks.");
  eq("note · Best available: as before", legsNote({ yourPicksOnly: false, legCount: 8, slipFloor: 6, generatedLegs: 2, usable: 6, total: 6 }), "Up to 25 · 6 from your picks, 2 from your cappers.");

  // Summary
  eq("summary · subset", pickSummary(subset), "7 of your 20 picks used");
  eq("summary · every pick in", pickSummary(allIn), "6 from your picks, 0 generated");
  eq("summary · Best available with generated legs", pickSummary(best), "6 from your picks, 2 generated");

  // Unused line
  eq("unused line", [unusedLine(13), unusedLine(1)], ["13 picks not used this time", "1 pick not used this time"]);
  eq("no unused picks outside subset mode", [unusedPicks(allIn).length, unusedPicks(best).length], [0, 0]);

  // Regenerate
  eq("Regenerate · every leg a pick, all in: disabled, 'All your picks are already in this parlay'", regenerateState(allIn, null), { disabled: true, hint: ALL_PICKS_IN });
  eq("Regenerate · subset: enabled", regenerateState(subset, null).disabled, false);
  eq("Regenerate · a generated leg: enabled", [nothingToVary(best), regenerateState(best, null).disabled], [false, false]);
  eq("Regenerate · after a comparable-strength miss: that message", regenerateState(best, "NO_COMPARABLE"), { disabled: false, hint: NO_COMPARABLE });
  eq("Regenerate · after an all-in miss: the all-in message", regenerateState(best, "ALL_PICKS_USED").hint, ALL_PICKS_IN);
  eq("Regenerate · no parlay legs: not 'nothing to vary'", nothingToVary({ legs: [], dropped: [] }), false);
}

// ---- 2 · The card -----------------------------------------------------------------------------
const requests: GenerateRequest[] = [];
let buildGenerated: typeof buildGeneratedParlay | null = null;
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-generate", {
  generateParlayAction: async (req: GenerateRequest) => {
    requests.push(req);
    if (!buildGenerated) throw new Error("generator not preloaded");
    const snapshot: GeneratorSnapshot = { ...snapshotOf(req.slipPickIds.map((id) => PICKS.find((p) => p.pickId === id)!)), targets: req.targets.map((t) => t.gameId) };
    return { snapshot, parlay: buildGenerated(snapshot, req.settings, null, new Date()) };
  },
});
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
  buildGenerated = buildGeneratedParlay;
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
  const fillFrom = (label: "Best available" | "Your picks only") => Array.from(el.querySelectorAll('[role="radiogroup"][aria-label="Fill from"] [role="radio"]')).find((b) => (b.textContent ?? "").trim() === label);
  const legsShown = () => button("More legs")?.previousElementSibling?.textContent;
  const parlayIds = () => Array.from(el.querySelectorAll("ol > li")).map((li) => li.textContent ?? "").join("|");
  const unusedButton = () => buttons().find((b) => /pick(s)? not used this time/.test(b.textContent ?? ""));

  win.localStorage.setItem("parlay-pool:u1", JSON.stringify({ version: 2, picks: PICKS as unknown as ExpanderPick[], targets: [], excludedLeagues: [], legacy: { addMode: false, legCount: 3, checkedPicks: [] } }));
  const root: Root = createRoot(el);
  await act(() => root.render(h(AppRouterContext.Provider, { value: router as never }, h(ParlayPoolProvider, { userId: "u1", children: null }, h(Probe), h(GeneratorCard, { leagues: ["MLB"] })))));
  await settle();

  // ---- Best available, 20 picks: the old rule - never fewer legs than picks ----
  check("Best available · 20 picks: Total legs is pushed up to 20", ctx.legCount === 20, `legs=${ctx.legCount}`);
  await click(button("Fewer legs"));
  check("Best available · Fewer legs can't go under the 20 picks", ctx.legCount === 20, `legs=${ctx.legCount}`);
  check("Best available · the note is the pick/capper split", text().includes("Up to 25 · 20 from your picks, 0 from your cappers."));

  // ---- Your picks only: down to 7 and to 1, nothing pushes it back ----
  await click(fillFrom("Your picks only"));
  for (let i = 0; i < 13; i++) await click(button("Fewer legs"));
  check("Your picks only · the stepper goes down to 7", ctx.legCount === 7 && legsShown() === "7", `legs=${ctx.legCount} shown=${legsShown()}`);
  check("Your picks only · the note reads '7 of your 20 picks'", text().includes("Up to 25 · 7 of your 20 picks."));
  for (let i = 0; i < 8; i++) await click(button("Fewer legs"));
  check("Your picks only · ...and to 1, where it stops", ctx.legCount === 1 && (button("Fewer legs") as HTMLButtonElement).disabled, `legs=${ctx.legCount}`);
  for (let i = 0; i < 6; i++) await click(button("More legs"));
  check("Your picks only · ...and back up to 7", ctx.legCount === 7, `legs=${ctx.legCount}`);

  // ---- Generate: exactly 7 legs, the summary, the collapsed unused line ----
  await generate();
  check("Generate · one request", requests.length === 1, `requests=${requests.length}`);
  check("result · 'Your parlay · 7 legs'", text().includes("Your parlay · 7 legs"));
  check("result · '7 of your 20 picks used'", text().includes("7 of your 20 picks used") && !text().includes("generated"));
  check("result · the engine's capacity now bounds the stepper at 20", text().includes("Up to 25 · 7 of your 20 picks."));
  for (let i = 0; i < 14; i++) await click(button("More legs"));
  check("Your picks only · after a build the stepper tops out at the engine's capacity (20)", ctx.legCount === 20 && (button("More legs") as HTMLButtonElement).disabled, `legs=${ctx.legCount}`);
  for (let i = 0; i < 13; i++) await click(button("Fewer legs"));
  check("Your picks only · ...and comes back to 7 without a new request", ctx.legCount === 7 && requests.length === 1 && text().includes("7 of your 20 picks used"), `legs=${ctx.legCount} requests=${requests.length}`);
  check("unused · ONE collapsed line: '13 picks not used this time'", unusedButton()?.textContent?.includes("13 picks not used this time") === true && unusedButton()?.getAttribute("aria-expanded") === "false");
  check("unused · no per-pick 'not in this parlay' notes anywhere", !text().includes("not in this parlay"));
  check("unused · collapsed: the list is not shown", el.querySelectorAll("ul.list-disc li").length === 0);
  await click(unusedButton());
  const listed = Array.from(el.querySelectorAll("ul.list-disc li")).map((li) => li.textContent ?? "");
  check("unused · expands to the 13 unused picks", unusedButton()?.getAttribute("aria-expanded") === "true" && listed.length === 13, `listed=${listed.length}`);
  const inParlay = new Set(Array.from(el.querySelectorAll("ol > li")).map((li) => (li.textContent ?? "").match(/Home p\d+/)?.[0]));
  check("unused · none of them is a leg of the parlay", listed.every((t) => !inParlay.has(t.match(/Home p\d+/)?.[0])) && inParlay.size === 7, `legs=${inParlay.size}`);
  await click(unusedButton());
  check("unused · collapses again", el.querySelectorAll("ul.list-disc li").length === 0);

  // ---- Regenerate: enabled, no request, another 7 ----
  const regen = () => button("Regenerate: Another parlay of comparable strength");
  check("Regenerate · enabled in subset mode", Boolean(regen()) && !regen()!.disabled);
  const seen = new Set([parlayIds()]);
  for (let i = 0; i < 5; i++) {
    await click(regen());
    seen.add(parlayIds());
  }
  check("Regenerate · no request, a different 7 on the taps", requests.length === 1 && seen.size > 1 && text().includes("7 of your 20 picks used") && text().includes("Your parlay · 7 legs"), `requests=${requests.length} distinct=${seen.size}`);

  // ---- 6 picks, 6 legs: all in; Regenerate disabled ----
  for (const p of PICKS.slice(6)) await act(() => ctx.removeFromPool(p.pickId));
  await settle();
  await act(() => ctx.setLegCount(6));
  await settle();
  check("6 picks · Your picks only still chosen", fillFrom("Your picks only")?.getAttribute("aria-checked") === "true", `pool=${ctx.pool.length}`);
  await generate();
  check("6 picks, 6 legs · 'Your parlay · 6 legs', the old summary", text().includes("Your parlay · 6 legs") && text().includes("6 from your picks, 0 generated"));
  check("6 picks, 6 legs · no unused line", unusedButton() === undefined);
  const off = button("Regenerate: " + ALL_PICKS_IN);
  check("6 picks, 6 legs · Regenerate is disabled", Boolean(off) && off!.disabled, `label=${buttons().map((b) => b.getAttribute("aria-label")).filter((l) => l?.startsWith("Regenerate")).join()}`);
  check("6 picks, 6 legs · its tooltip reads 'All your picks are already in this parlay'", off?.getAttribute("title") === ALL_PICKS_IN);
  const reqs = requests.length;
  await click(off);
  check("6 picks, 6 legs · tapping it does nothing", requests.length === reqs && !text().includes("No other parlays"));

  // ---- Best available, 8 legs on 6 picks: generated legs keep Regenerate on ----
  await click(fillFrom("Best available"));
  await act(() => ctx.setLegCount(8));
  await generate();
  check("Best available · 8 legs: 6 from your picks, 2 generated (unchanged text)", text().includes("Your parlay · 8 legs") && text().includes("6 from your picks, 2 generated") && !text().includes("picks used"), text().slice(-300));
  const regenBest = buttons().find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Regenerate"));
  check("Best available · Regenerate enabled, the usual tooltip", Boolean(regenBest) && !regenBest!.disabled && regenBest!.getAttribute("title") === "Another parlay of comparable strength");
  check("Best available · no unused line", unusedButton() === undefined);
  await act(() => root.unmount());

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
