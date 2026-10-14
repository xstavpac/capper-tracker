// Proof of Auto-Generate's "Include Picks" control and Pick Mix popover on
// /parlay: the three-way control, "Customize Mix" showing only with All, the
// popover's slider / presets / live leg split, Cancel vs Done, the active-mix
// chip (reopen, ✕ to clear), the mix surviving a switch away from All and
// back, what the action is sent, and how the result shows its notes and the
// Hedge / Contrarian note.
//
// The real AutoGenerateSection is rendered on a jsdom document; only the
// server action is replaced. Which legs get built is proven in
// lib/parlay/pick-mix-acceptance-test.ts. This checks behavior, not looks.
// Run: npx tsx src/components/parlay/pick-mix-controls-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { JSDOM } from "jsdom";
import type { AutoParlay, GeneratorPick, SwapMode, SwapParlay } from "@/lib/parlay/auto-generate";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const FUTURE = "2099-01-01T00:00:00.000Z";
function pick(id: string, game: number, betDetail: string): GeneratorPick {
  const home = "Home" + game;
  const away = "Away" + game;
  return {
    pickId: id, capperId: "capper-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false,
    category: "OVER", leagueName: "MLB", gameId: "game" + game, gameLabel: away + " @ " + home, betDetail,
    odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: betDetail, line: null,
    homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: home, teamColor: null,
    datePosted: "2098-12-31T00:00:00.000Z", oddsSource: "STATED",
  };
}
const PICKS = Array.from({ length: 20 }, (_, i) => pick("p" + i, i, "Leg-" + i));

const calls: unknown[][] = [];
// What the next generate returns on top of the plain result - set by each step.
let extra: Record<string, unknown> = {};
let available: number | null = null;

function parlayAFor(requested: number): AutoParlay {
  const legs = PICKS.slice(0, available ?? requested).slice(0, requested).map((p) => ({
    gameId: p.gameId, gameLabel: p.gameLabel, gameTime: p.gameTime, top: { pick: p, record: null }, next: [],
  }));
  return { requested, available: available ?? 20, legs };
}
function swapParlay(mode: SwapMode, parlayA: AutoParlay): SwapParlay {
  return { mode, legs: parlayA.legs.map((l) => ({ gameId: l.gameId, gameLabel: l.gameLabel, original: l.top, swap: null, unchangedReason: "NO_ALTERNATE" as const })), swapCount: 0 };
}

function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-generator", {
  autoGenerateParlayAction: async (...args: unknown[]) => {
    calls.push(args);
    const [, legCount, max, includePicks, gameLinesPct] = args as [string[], number, number, string, number | null];
    const parlayA = parlayAFor(legCount);
    return {
      parlayA,
      sameGame: { maxLegsPerGame: max, legs: [] },
      hedge: swapParlay("AUTO_HEDGE", parlayA),
      contrarian: swapParlay("CONTRARIAN", parlayA),
      records: { records: {}, streaks: {}, last20: {} },
      leaguesSearched: ["MLB"],
      includePicks,
      gameLinesPct,
      notes: [],
      swapNote: null,
      ...extra,
    };
  },
});

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/parlay" });
  const win = dom.window;
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.self = win;
  g.document = win.document;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
  Object.defineProperty(win.document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = async () => ({ ok: true, json: async () => ({ url: null, legs: [] }) });

  const React = await import("react");
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { AutoGenerateSection } = await import("./auto-generate-section");
  const h = React.createElement;
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(h(AutoGenerateSection, { leagues: ["MLB"] }));
    await settle();
  });
  const text = () => container.textContent ?? "";
  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const button = (starts: string) => buttons().find((b) => (b.textContent ?? "").startsWith(starts));
  const byLabel = (label: string) => buttons().find((b) => b.getAttribute("aria-label") === label);
  const include = (label: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Include picks"] [role="radio"]')).find((b) => b.textContent === label);
  const dialog = () => container.querySelector('[role="dialog"][aria-label="Pick Mix"]');
  const chip = () => buttons().find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Edit pick mix"));
  const click = (el: Element | undefined) =>
    act(async () => {
      (el as HTMLElement | undefined)?.click();
      await settle();
    });
  const lastCall = () => JSON.stringify(calls[calls.length - 1]);
  const slide = (value: number) =>
    act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="range"]')!;
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      await settle();
    });
  const key = (k: string) =>
    act(async () => {
      win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: k }));
      await settle();
    });

  // ---------------------------------------------------------------------
  // Defaults: All, no mix, and the action is sent exactly that
  // ---------------------------------------------------------------------
  check("three options, exactly", Array.from(container.querySelectorAll('[aria-label="Include picks"] [role="radio"]')).map((b) => b.textContent).join("|") === "All|Game Lines|Props");
  check("All is selected by default", include("All")?.getAttribute("aria-checked") === "true");
  check("Customize Mix shows with All", button("Customize Mix") !== undefined);
  check("no chip while no mix is set", chip() === undefined);
  check("the other controls are still there", text().includes("League scope") && byLabel("More legs") !== undefined && text().includes("Max legs per game") && button("Clear") !== undefined && button("Generate parlay") !== undefined);
  await click(button("Generate parlay"));
  check("All, no mix: action sent ALL and no mix", lastCall() === JSON.stringify([["MLB"], 3, 1, "ALL", null]), lastCall());
  check("plain All: subtitle unchanged", text().includes("ranked by their record in that market") && !text().includes("mix "));

  // ---------------------------------------------------------------------
  // The popover: title, helper, presets, slider, live split, Cancel
  // ---------------------------------------------------------------------
  await click(button("Customize Mix"));
  check("popover opens", dialog() !== null);
  check("title and helper text", text().includes("Pick Mix") && text().includes("Set how many legs come from Game Lines vs Props when using All."));
  check("six presets", ["100/0", "80/20", "60/40", "50/50", "30/70", "0/100"].every((p) => button(p) !== undefined));
  check("starts at 50/50 with the live split for 3 legs", text().includes("50 / 50 → 2 Game Lines · 1 Prop"), text());
  await click(button("60/40"));
  check("preset 60/40 updates the split live", text().includes("60 / 40 → 2 Game Lines · 1 Prop") && text().includes("Game Lines 60%") && text().includes("Props 40%"));
  await slide(30);
  check("the slider updates the split live", text().includes("30 / 70 → 1 Game Line · 2 Props"), text());
  check("slider steps by 10 from 0 to 100", (() => {
    const input = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    return input.step === "10" && input.min === "0" && input.max === "100";
  })());
  await click(button("Cancel"));
  check("Cancel closes it", dialog() === null);
  check("Cancel saves nothing: no chip", chip() === undefined);
  await click(button("Customize Mix"));
  check("reopened after Cancel: the discarded draft is gone", text().includes("50 / 50 → 2 Game Lines · 1 Prop"));
  await click(button("80/20"));
  await key("Escape");
  check("Escape closes it without saving", dialog() === null && chip() === undefined);

  // ---------------------------------------------------------------------
  // Done saves; the chip; the leg split follows the leg count
  // ---------------------------------------------------------------------
  await click(button("Customize Mix"));
  await click(button("60/40"));
  await click(button("Done"));
  check("Done closes it", dialog() === null);
  check("chip shows the active mix", chip()?.textContent === "60/40", chip()?.textContent ?? "none");
  check("saving a mix clears the old result", !text().includes("Generated parlay"));
  for (let i = 0; i < 4; i++) await click(byLabel("More legs"));
  await click(chip());
  check("the chip reopens the popover, at the saved mix", dialog() !== null && text().includes("60 / 40 → 4 Game Lines · 3 Props"), text());
  await click(button("Cancel"));
  await click(button("Generate parlay"));
  check("All + mix: action sent ALL and 60", lastCall() === JSON.stringify([["MLB"], 7, 1, "ALL", 60]), lastCall());
  check("result says which mix it was built with", text().includes("mix 60 / 40 (4 game lines, 3 props)"));

  // ---------------------------------------------------------------------
  // Game Lines / Props: no mix controls, mix not sent, but kept for later
  // ---------------------------------------------------------------------
  await click(include("Props"));
  check("Props selected", include("Props")?.getAttribute("aria-checked") === "true");
  check("switching the filter clears the old result", !text().includes("Generated parlay"));
  check("Customize Mix hidden away from All", button("Customize Mix") === undefined);
  check("chip hidden away from All", chip() === undefined);
  extra = { swapNote: "Hedge and Contrarian swap game lines only.", notes: ["No props available for NHL right now."] };
  await click(button("Generate parlay"));
  check("Props: action sent PROPS and no mix", lastCall() === JSON.stringify([["MLB"], 7, 1, "PROPS", null]), lastCall());
  check("Props: subtitle says so", text().includes("props only"));
  check("a note from the result is shown as plain text", text().includes("No props available for NHL right now."));
  const hedgeTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => (t.textContent ?? "").startsWith("Hedge"));
  check("Hedge tab has no 0/N count when swaps can't apply", hedgeTab?.textContent === "Hedge", hedgeTab?.textContent ?? "none");
  await click(hedgeTab);
  check("Hedge tab shows the note instead of a 0/N result", text().includes("Hedge and Contrarian swap game lines only.") && !text().includes("0/7"));

  await click(include("Game Lines"));
  extra = {};
  await click(button("Generate parlay"));
  check("Game Lines: action sent GAME_LINES and no mix", lastCall() === JSON.stringify([["MLB"], 7, 1, "GAME_LINES", null]), lastCall());
  const hedgeAgain = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => (t.textContent ?? "").startsWith("Hedge"));
  check("Game Lines: Hedge keeps its count", hedgeAgain?.textContent === "Hedge0/7", hedgeAgain?.textContent ?? "none");

  await click(include("All"));
  check("back to All: the mix is still set", chip()?.textContent === "60/40");

  // ---------------------------------------------------------------------
  // Mix notes; the empty state; ✕ clears the mix
  // ---------------------------------------------------------------------
  extra = { notes: ["Only 1 eligible prop — filled 2 extra legs with Game Lines."] };
  await click(button("Generate parlay"));
  check("mix shortfall note shown with the result", text().includes("Only 1 eligible prop — filled 2 extra legs with Game Lines."));

  available = 0;
  extra = { notes: ["No props available for WNBA right now."] };
  await click(include("Props"));
  await click(button("Generate parlay"));
  check("nothing to build: the filter's empty state replaces the generic one", text().includes("No props available for WNBA right now.") && !text().includes("No games left"));
  available = null;
  extra = {};

  await click(include("All"));
  await click(byLabel("Clear pick mix"));
  check("✕ clears the mix", chip() === undefined && button("Customize Mix") !== undefined);
  await click(button("Generate parlay"));
  check("after ✕: action sent no mix", lastCall() === JSON.stringify([["MLB"], 7, 1, "ALL", null]), lastCall());

  await act(async () => root.unmount());
  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
