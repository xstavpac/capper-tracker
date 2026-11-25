// Fill from = Combined in the UI (combined-ui.ts, combined-mix-box.tsx, generator-card.tsx,
// generator-result.tsx, parlay-workspace.tsx on top of generator.ts rule 7). Two halves:
//   1. The pure words: Fill from helpers, section 1 subtitle, the stat tile sublines, the Total legs
//      note, the split pill and the rotation strip.
//   2. The real /parlay workspace on jsdom (real slip provider, real engine; only the server calls
//      are replaced): Combined is the default with picks, the mix box and its slider, the tiles,
//      Total legs keeping the split's proportion, Generate / Regenerate with the result card's split,
//      strip and "Your pick" legs, the win-rate text gone, and an emptied slip falling back to Best
//      available with Combined / Your picks only disabled.
// Pure - no DB. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/components/parlay/combined-ui-acceptance-test.ts
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import { buildGeneratedParlay, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { combinedLegsNote, fillFromHelp, legsSplitSub, rotationFooter, rotationStrip, slipSubtitle, splitPercents, yourPicksSub } from "@/lib/parlay/combined-ui";
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { GenerateRequest } from "@/server/actions/parlay-generate";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
const eq = (label: string, actual: unknown, expected: unknown) => check(label, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

// ---- 1 · The words ------------------------------------------------------------------------------
eq("helper · empty slip: none", fillFromHelp("COMBINED", 0), null);
eq(
  "helper · per mode",
  [fillFromHelp("BEST_AVAILABLE", 3), fillFromHelp("COMBINED", 3), fillFromHelp("YOUR_PICKS_ONLY", 3)],
  ["Generator picks every leg from your cappers.", "Mix your picks with the generator's best.", "Builds only from your picks."]
);
eq("section 1 subtitle", [slipSubtitle(0), slipSubtitle(1), slipSubtitle(20)], ["No picks in your slip yet", "1 pick in your slip", "20 picks in your slip"]);
eq(
  "Your picks tile",
  [yourPicksSub("COMBINED", 20, 3), yourPicksSub("YOUR_PICKS_ONLY", 20, 0), yourPicksSub("BEST_AVAILABLE", 20, 0), yourPicksSub("BEST_AVAILABLE", 0, 0)],
  ["3 used per parlay · rotates", "Total legs drawn from these", "not used in Best available", "add picks from Live"]
);
eq("Legs tile and Total legs note", [legsSplitSub(3, 7), combinedLegsNote(3, 7)], ["3 from your picks · 7 generated", "Up to 25 · 3 from your picks, 7 from your cappers."]);
eq("split pill", [splitPercents(3, 10).text, splitPercents(0, 10).text, splitPercents(10, 10).text], ["30% manual · 70% auto", "0% manual · 100% auto", "100% manual · 0% auto"]);
eq("footer", rotationFooter(20), "Regenerate rotates through all 20 of your picks.");
eq(
  "rotation strip",
  rotationStrip({ build: 2, used: [], slipSize: 20, unusedLeft: 14, nextUses: 3 }),
  "Build 2 of your rotation · next Regenerate uses 3 picks you haven't used yet (14 left)"
);

// ---- Fixture: 30 MLB games; 20 slip picks (home ML on G0..G19), an Over at 80% on every game ------
const NOW = new Date("2099-06-01T12:00:00.000Z");
const FUTURE = "2099-06-01T23:00:00.000Z";
const categoryRecords: GeneratorSnapshot["categoryRecords"] = {};
const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
function pick(id: string, game: number, over: boolean, winPct: number): GeneratorPick {
  const category = over ? "OVER" : "FAV_ML";
  const rec = { wins: winPct, losses: 100 - winPct, pushes: 0, winPct, count: 100 };
  categoryRecords[`cap-${id}|${category}`] = { key: category, label: category, ...rec };
  leagueRecords.records[`cap-${id}|MLB|${category}`] = { category, label: category, overall: rec, league: rec };
  const home = `Home${game}`;
  const away = `Away${game}`;
  const detail = over ? "Over 8.5" : `${home} ML`;
  return {
    pickId: id, capperId: "cap-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category, leagueName: "MLB",
    gameId: "G" + game, gameLabel: `${away} @ ${home}`, betDetail: detail, odds: -110, units: 1, status: "PENDING", betType: over ? "TOTAL" : "MONEYLINE", period: "FULL_GAME",
    rawBetDetail: detail, propMarket: null, line: over ? 8.5 : null, homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: "", teamColor: null,
    datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}
const SLIP = Array.from({ length: 20 }, (_, i) => pick(`s${i + 1}`, i, false, 55 + i));
const OVERS = Array.from({ length: 30 }, (_, g) => pick(`o${g}`, g, true, 80));
const games: GeneratorGame[] = Array.from({ length: 30 }, (_, g) => ({
  gameId: "G" + g,
  gameLabel: `Away${g} @ Home${g}`,
  gameTime: FUTURE,
  leagueName: "MLB",
  picks: [...SLIP, ...OVERS].filter((p) => p.gameId === "G" + g),
}));

// ---- 2 · The workspace --------------------------------------------------------------------------
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
    const slip = req.slipPickIds.map((id) => SLIP.find((p) => p.pickId === id)!);
    const snapshot: GeneratorSnapshot = { builtAt: new Date().toISOString(), games, slipPicks: slip, targets: [], leagueRecords, categoryRecords };
    return { snapshot, parlay: buildGenerated(snapshot, req.settings, null, new Date()) };
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
  buildGenerated = buildGeneratedParlay;
  const React = await import("react");
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { ParlayPoolProvider, useParlayPool } = await import("./parlay-pool-context");
  const { ParlayWorkspace } = await import("./parlay-workspace");
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
  const fillFrom = (label: string) =>
    Array.from(el.querySelectorAll('[role="radiogroup"][aria-label="Fill from"] [role="radio"]')).find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
  const slider = () => el.querySelector('input[type="range"][aria-label="Manual versus auto picks"]') as HTMLInputElement | null;
  const slide = async (n: number) => {
    const input = slider()!;
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    await act(() => {
      setter.call(input, String(n));
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    await settle();
  };
  const mixCounts = () => [el.querySelector("[data-manual-count]")?.textContent, el.querySelector("[data-auto-count]")?.textContent];

  win.localStorage.setItem("parlay-pool:u1", JSON.stringify({ version: 2, picks: SLIP as unknown as ExpanderPick[], targets: [], excludedLeagues: [], legacy: { addMode: false, legCount: 10, checkedPicks: [] } }));
  const root: Root = createRoot(el);
  await act(() => root.render(h(AppRouterContext.Provider, { value: router as never }, h(ParlayPoolProvider, { userId: "u1", children: null }, h(Probe), h(ParlayWorkspace, { leagues: ["MLB"] })))));
  await settle();

  // ---- Combined by default, its mix box ----
  check("default · Combined is chosen with picks; Total legs stays 10 (no Best available floor)", fillFrom("Combined")?.getAttribute("aria-checked") === "true" && ctx.legCount === 10, `legs=${ctx.legCount}`);
  check("default · the helper", text().includes("Mix your picks with the generator's best."));
  check("section 1 · '20 picks in your slip'", text().includes("20 picks in your slip") && !text().includes("Picks you've locked in"));
  check("mix box · shown under Combined", el.querySelector("[data-mix-box]") !== null);
  eq("mix box · 5 Manual Picks / 5 Auto Picks (half of 10)", mixCounts(), ["5", "5"]);
  check("mix box · the labels and descriptions", ["Manual Picks", "Auto Picks", "Picks you've personally selected from the capper catalog.", "Picks independently selected by the generator."].every((t) => text().includes(t)));
  eq("slider · min 0, max min(10, 20) = 10, value 5, one step per leg", [slider()?.min, slider()?.max, slider()?.value, slider()?.step], ["0", "10", "5", "1"]);
  check("slider · All auto / All manual / the pill / the footer", ["All auto", "All manual", "50% manual · 50% auto", "Regenerate rotates through all 20 of your picks."].every((t) => text().includes(t)));
  check("tiles · Your picks: 5 used per parlay · rotates; Legs: 5 from your picks · 5 generated", text().includes("5 used per parlay · rotates") && text().includes("5 from your picks · 5 generated"));
  check("Total legs note · the split", text().includes("Up to 25 · 5 from your picks, 5 from your cappers."));

  // ---- The slider ----
  await slide(3);
  eq("slider to 3 · 3 manual / 7 auto", mixCounts(), ["3", "7"]);
  check("slider to 3 · pill, tiles and note follow", text().includes("30% manual · 70% auto") && text().includes("3 used per parlay · rotates") && text().includes("Up to 25 · 3 from your picks, 7 from your cappers."));

  // ---- Win-rate text gone, the stepper kept ----
  check("Minimum capper win rate · the long explanation is gone", !text().includes("Judged on each capper's record") && !text().includes("means more risk"));
  check("Minimum capper win rate · stepper still there at 55%", Boolean(button("Fewer: Minimum capper win rate")) && text().includes("55%"));

  // ---- Generate: one request with the split ----
  await generate();
  const sent = requests[requests.length - 1];
  eq("Generate · the request carries Combined and manualSlots 3", [requests.length, sent.settings.fillFrom, sent.settings.manualSlots, sent.settings.legCount], [1, "COMBINED", 3, 10]);
  check("result · header split '3 your picks · 7 generator'", el.querySelector("[data-combined-split]")?.textContent?.replace(/\s+/g, " ").includes("3 your picks · 7 generator") === true, el.querySelector("[data-combined-split]")?.textContent ?? "none");
  check(
    "result · strip: Build 1 · next Regenerate uses 3 picks (17 left)",
    el.querySelector("[data-rotation-strip]")?.textContent?.includes("Build 1 of your rotation · next Regenerate uses 3 picks you haven't used yet (17 left)") === true
  );
  eq("result · 3 manual legs, each with a 'Your pick' pin badge", [el.querySelectorAll("[data-manual-leg]").length, el.querySelectorAll("[data-your-pick-tag]").length], [3, 3]);
  const manualText = () => Array.from(el.querySelectorAll("[data-manual-leg]")).map((li) => (li.textContent ?? "").match(/Home\d+ ML/)?.[0]).sort();
  eq("result · build 1 is the slip's top 3", manualText(), ["Home17 ML", "Home18 ML", "Home19 ML"]);

  // ---- Regenerate: no request, the next 3, Build 2 ----
  await click(buttons().find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Regenerate")));
  check("Regenerate · no request", requests.length === 1, `requests=${requests.length}`);
  check("Regenerate · Build 2, 14 left", el.querySelector("[data-rotation-strip]")?.textContent?.includes("Build 2 of your rotation · next Regenerate uses 3 picks you haven't used yet (14 left)") === true, el.querySelector("[data-rotation-strip]")?.textContent ?? "");
  eq("Regenerate · the next 3 by record", manualText(), ["Home14 ML", "Home15 ML", "Home16 ML"]);

  // ---- Total legs keeps the proportion ----
  for (let i = 0; i < 4; i++) await click(button("Fewer legs"));
  eq("Total legs 10 -> 6 · 3 of 10 becomes 2 of 6", [ctx.legCount, mixCounts()], [6, ["2", "4"]]);

  // ---- The other modes ----
  await click(fillFrom("Best available"));
  check("Best available · mix box gone, its helper, the tile says not used", el.querySelector("[data-mix-box]") === null && text().includes("Generator picks every leg from your cappers.") && text().includes("not used in Best available"));
  await click(fillFrom("Your picks only"));
  check("Your picks only · its helper and tile", text().includes("Builds only from your picks.") && text().includes("Total legs drawn from these"));
  await click(fillFrom("Combined"));

  // ---- Clearing the slip in Combined falls back to Best available ----
  await act(() => ctx.clearSlip());
  await settle();
  check("cleared · Best available chosen, the mix box gone", fillFrom("Best available")?.getAttribute("aria-checked") === "true" && el.querySelector("[data-mix-box]") === null);
  check(
    "cleared · Combined and Your picks only disabled, titled 'Add picks from Live first'",
    Boolean(fillFrom("Combined")?.disabled && fillFrom("Your picks only")?.disabled) && fillFrom("Combined")?.title === "Add picks from Live first"
  );
  check(
    "cleared · 'Add picks from Live first' is ONLY the hover title on the two disabled buttons, never visible text",
    !text().includes("Add picks from Live first") &&
      Array.from(el.querySelectorAll('[title="Add picks from Live first"]')).map((b) => (b.textContent ?? "").trim()).join("|") === "Combined|Your picks only"
  );
  {
    const row = el.querySelector('[role="radiogroup"][aria-label="Fill from"]')?.closest(".grid");
    check("cleared · the Fill from row holds only its label and the three buttons (no helper)", row?.textContent === "Fill fromBest availableCombinedYour picks only", JSON.stringify(row?.textContent));
  }
  check("cleared · no helper beside Fill from; subtitle and tile say so", !text().includes("Generator picks every leg from your cappers.") && text().includes("No picks in your slip yet") && text().includes("add picks from Live"));

  await act(() => root.unmount());
}

main().then(
  () => {
    if (failures > 0) {
      console.log(`\n${failures} FAILED`);
      process.exit(1);
    }
    console.log("\nAll Combined UI checks passed.");
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
