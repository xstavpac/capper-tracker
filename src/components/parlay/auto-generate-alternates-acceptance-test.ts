// Proof of how Auto-Generate shows its Primary + alternates on /parlay: the
// Primary / Alt 1 / Alt 2 tabs, a Send to FanDuel on each parlay, Regenerate
// sending back every leg set shown and numbering on, "No more distinct
// parlays with these settings" when nothing new is left (keeping what is on
// screen, never a repeat), Generate starting over, and the slip's locks being
// sent. Which legs get chosen is proven in lib/parlay/alternates-acceptance-test.ts.
//
// The real AutoGenerateSection and ParlayPoolProvider are rendered on a jsdom
// document. Only the server actions are replaced.
// Run: npx tsx src/components/parlay/auto-generate-alternates-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { JSDOM } from "jsdom";
import type { AutoParlay, GeneratorPick, SwapMode, SwapParlay } from "@/lib/parlay/auto-generate";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const FUTURE = "2099-01-01T00:00:00.000Z";
function pick(id: string, game: number): GeneratorPick {
  const home = "Home" + game;
  const away = "Away" + game;
  return {
    pickId: id, capperId: "capper-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false,
    category: null, leagueName: "MLB", gameId: "game" + game, gameLabel: away + " @ " + home, betDetail: "Leg-" + id,
    odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: home + " ML", line: null,
    homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: home, teamColor: null,
    datePosted: "2098-12-31T00:00:00.000Z",
  };
}
function parlay(ids: string[]): AutoParlay {
  const legs = ids.map((id, i) => {
    const p = pick(id, i + 1);
    return { gameId: p.gameId, gameLabel: p.gameLabel, gameTime: p.gameTime, top: { pick: p, record: null }, next: [] };
  });
  return { requested: 2, available: 4, legs };
}
const swap = (mode: SwapMode, a: AutoParlay): SwapParlay => ({
  mode,
  legs: a.legs.map((l) => ({ gameId: l.gameId, gameLabel: l.gameLabel, original: l.top, swap: null, unchangedReason: "NO_ALTERNATE" as const })),
  swapCount: 0,
});

// Each answer the server gives, in order: a first Generate, two Regenerates
// (the second finds nothing new), then a Generate again.
const SETS = [
  [["a1", "b1"], ["a2", "b2"], ["a3", "b3"]],
  [["a4", "b4"], ["a5", "b5"], ["a6", "b6"]],
  [],
  [["a1", "b1"], ["a2", "b2"], ["a3", "b3"]],
];
const calls: { exclude: string[] | null; slip: unknown }[] = [];
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-slip", {
  getSlipPickStatesAction: async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, started: false }])),
});
stub("../../server/actions/parlay-generator", {
  autoGenerateParlayAction: async (_l: string[], _n: number, _m: number, _i: string, _p: number | null, options: { slip: unknown; exclude: string[] | null }) => {
    calls.push({ exclude: options.exclude, slip: options.slip });
    const set = SETS[calls.length - 1].map((ids) => parlay(ids));
    const first = set[0] ?? parlay(["a1", "b1"]);
    return {
      parlayA: first,
      sameGame: { maxLegsPerGame: 1, legs: [] },
      parlays: set.map((p) => ({ parlay: p, sameGame: { maxLegsPerGame: 1, legs: [] } })),
      regenerated: options.exclude !== null,
      exhausted: set.length < 3,
      hedge: swap("AUTO_HEDGE", first),
      contrarian: swap("CONTRARIAN", first),
      records: { records: {}, streaks: {}, last20: {} },
      leaguesSearched: ["MLB"],
      includePicks: "ALL",
      gameLinesPct: null,
      notes: [],
      swapNote: null,
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

  // A slip with one locked pick and one locked game.
  const slipPick = pick("slip1", 7);
  win.localStorage.setItem(
    "parlay-pool:user-1",
    JSON.stringify({
      pool: [slipPick],
      legCount: 2,
      games: [{ gameId: "game8", gameLabel: "Away8 @ Home8", gameTime: FUTURE, leagueName: "MLB" }],
      locked: ["slip1", "game:game8"],
    })
  );

  const React = await import("react");
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { AutoGenerateSection } = await import("./auto-generate-section");
  const { ParlayPoolProvider } = await import("./parlay-pool-context");
  const h = React.createElement;
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(h(ParlayPoolProvider, { userId: "user-1", children: null }, h(AutoGenerateSection, { leagues: ["MLB"] })));
    await settle();
  });
  const text = () => container.textContent ?? "";
  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const button = (starts: string) => buttons().find((b) => (b.textContent ?? "").startsWith(starts));
  const tabs = () => Array.from(container.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
  const tab = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => t.textContent === label);
  const click = (el: Element | undefined) => act(async () => {
    (el as HTMLElement | undefined)?.click();
    await settle();
  });
  const legsShown = () => (text().match(/Leg-[ab]\d/g) ?? []).filter((v, i, a) => a.indexOf(v) === i);
  const sendButtons = () => buttons().filter((b) => /Send to FanDuel/.test(b.textContent ?? "")).length;

  // ---------------------------------------------------------------------
  // 1. Generate: Primary + two alternates, each its own parlay
  // ---------------------------------------------------------------------
  await click(button("Generate parlay"));
  check("generate: the request is a first Generate (no exclude)", calls[0]?.exclude === null, JSON.stringify(calls[0]));
  check(
    "generate: the slip's picks and games are sent by id, with their locks",
    JSON.stringify(calls[0]?.slip) === JSON.stringify({ picks: [{ pickId: "slip1", locked: true }], games: [{ gameId: "game8", locked: true }] }),
    JSON.stringify(calls[0]?.slip)
  );
  check("generate: tabs are Primary, Alt 1, Alt 2, Hedge, Contrarian", JSON.stringify(tabs().map((t) => t?.replace(/\d+\/\d+$/, ""))) === JSON.stringify(["Primary", "Alt 1", "Alt 2", "Hedge", "Contrarian"]), JSON.stringify(tabs()));
  check("generate: the Primary is Parlay A", text().includes("Parlay A — 2-leg parlay") && legsShown().join() === "Leg-a1,Leg-b1", legsShown().join());
  check("generate: the Primary has Send to FanDuel", sendButtons() === 1, `send buttons=${sendButtons()}`);
  await click(tab("Alt 1"));
  check("Alt 1: its own legs", text().includes("Alternate 1 — 2-leg parlay") && legsShown().join() === "Leg-a2,Leg-b2", legsShown().join());
  check("Alt 1: has Send to FanDuel", sendButtons() === 1);
  await click(tab("Alt 2"));
  check("Alt 2: its own legs and Send to FanDuel", text().includes("Alternate 2 — 2-leg parlay") && legsShown().join() === "Leg-a3,Leg-b3" && sendButtons() === 1, legsShown().join());
  check("generate: no 'no more' message while a full set came back", !text().includes("No more distinct parlays"));

  // ---------------------------------------------------------------------
  // 2. Regenerate: sends every leg set shown, gets three new, numbers on
  // ---------------------------------------------------------------------
  await click(button("Regenerate"));
  check("regenerate: sends the three leg sets shown", JSON.stringify(calls[1]?.exclude) === JSON.stringify(["a1,b1", "a2,b2", "a3,b3"]), JSON.stringify(calls[1]?.exclude));
  check("regenerate: tabs number on - Alt 3, Alt 4, Alt 5", JSON.stringify(tabs().slice(0, 3)) === JSON.stringify(["Alt 3", "Alt 4", "Alt 5"]), JSON.stringify(tabs()));
  check("regenerate: the first new parlay is shown", text().includes("Alternate 3 — 2-leg parlay") && legsShown().join() === "Leg-a4,Leg-b4", legsShown().join());

  // ---------------------------------------------------------------------
  // 3. Nothing new left: the message, and what is on screen stays
  // ---------------------------------------------------------------------
  await click(button("Regenerate"));
  check("exhausted: sent all six leg sets", calls[2]?.exclude?.length === 6, JSON.stringify(calls[2]?.exclude));
  check("exhausted: says so", text().includes("No more distinct parlays with these settings"));
  check("exhausted: keeps the parlays already on screen, no repeat", legsShown().join() === "Leg-a4,Leg-b4" && tabs()[0] === "Alt 3", legsShown().join());
  check("exhausted: Regenerate is off", button("Regenerate")?.disabled === true);

  // ---------------------------------------------------------------------
  // 4. Generate starts the session over
  // ---------------------------------------------------------------------
  await click(button("Generate parlay"));
  check("generate again: a fresh first Generate", calls[3]?.exclude === null, JSON.stringify(calls[3]));
  check("generate again: Primary is back, message gone", tabs()[0] === "Primary" && !text().includes("No more distinct parlays"), JSON.stringify(tabs()));

  await act(() => root.unmount());
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
