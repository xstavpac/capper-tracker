// Proof that a failed records request never leaves My Picks stuck: the slip's
// record loader and the Build from slip button both recover, say what happened,
// and work again on the next try. Also that the built legs come out in the
// same order whatever order the slip holds them in.
//
// The real ParlayPoolProvider and ParlayPoolSection are rendered on a jsdom
// document. Only the server actions are replaced; getLeagueRecordsAction and
// buildSlipParlayAction can be told to fail. The build stub runs the real
// buildFromSlip (lib/parlay/slip-build.ts) over the slip's picks.
// Run: npx tsx src/components/parlay/parlay-build-failure-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { JSDOM } from "jsdom";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";
import { buildFromSlip, type SlipSource } from "@/lib/parlay/slip-build";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// A rejection nothing handles is exactly the bug: it is counted, not fatal.
let unhandled = 0;
process.on("unhandledRejection", () => {
  unhandled++;
});

const FUTURE = "2099-01-01T00:00:00.000Z";
function pick(i: number): ExpanderPick {
  const home = "Home" + i;
  const away = "Away" + i;
  return {
    pickId: "p" + i, capperId: "capper-p" + i, capperName: "Capper p" + i, capperColorTag: null, capperIsFavorite: false,
    category: null, leagueName: "MLB", gameId: "game" + i, gameLabel: away + " @ " + home, betDetail: home + " ML",
    odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: home + " ML", line: null,
    homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: home, teamColor: null,
    datePosted: "2098-12-31T00:00:00.000Z",
  };
}
// Held in the slip out of id order, with identical (empty) records.
const SLIP = [pick(3), pick(1), pick(2)];

function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-slip", {
  getSlipPickStatesAction: async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, started: false }])),
});
let recordsFail = true;
let recordCalls = 0;
stub("../../server/actions/picks", {
  getLeagueRecordsAction: async () => {
    recordCalls++;
    if (recordsFail) throw new Error("records unavailable");
    return { records: {}, streaks: {}, last20: {} };
  },
});
stub("../../server/actions/parlay-pool-generator", {
  generatePoolSwapAction: async () => ({ error: "not used here" }),
  buildSlipParlayAction: async (items: { pickId: string; locked: boolean }[], legCount: number, source: SlipSource) => {
    if (recordsFail) throw new Error("records unavailable");
    const picks = items.map((i) => ({ pick: SLIP.find((p) => p.pickId === i.pickId) as GeneratorPick, locked: i.locked }));
    const records = { records: {}, streaks: {}, last20: {} };
    const built = buildFromSlip({ picks, games: [], pool: [], records, legCount, source });
    return "error" in built ? built : { ...built, records };
  },
});

const BUILD_ERROR = "Couldn't build this parlay right now - try again.";

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

  const React = await import("react");
  // tsx compiles the components' JSX to React.createElement (tsconfig "jsx": "preserve"), with no import of its own.
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { ParlayPoolProvider } = await import("./parlay-pool-context");
  const { ParlayPoolSection } = await import("./parlay-pool-section");
  const h = React.createElement;
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());

  win.localStorage.setItem("parlay-pool:user-1", JSON.stringify({ pool: SLIP, leagueScope: { MLB: true }, legCount: 3 }));
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(h(ParlayPoolProvider, { userId: "user-1", children: null }, h(ParlayPoolSection)));
    await settle();
  });

  const text = () => container.textContent ?? "";
  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  // The Build from slip segment: its label ("Build from slip", or "Building…" mid-build) over its Source.
  const buildButton = () => buttons().find((b) => /slip \+ qualified$|slip only$/.test(b.textContent ?? ""));
  const buildLabel = () => buildButton()?.firstElementChild?.textContent;
  const click = (el: Element | undefined) => act(async () => {
    (el as HTMLElement | undefined)?.click();
    await settle();
  });

  // ---------------------------------------------------------------------
  // 1. The slip's own record loader fails
  // ---------------------------------------------------------------------
  check("setup: the 3-pick slip is shown and its records were requested", text().includes("Capper p1") && recordCalls === 1, `recordCalls=${recordCalls}`);
  check("records loader fails: the failure is handled", unhandled === 0, `unhandled rejections=${unhandled}`);
  check("records loader fails: the slip says so", text().includes("Couldn't load your cappers' records"));
  check("records loader fails: the picks are still listed and Build is still available", text().includes("Capper p3") && buildButton()?.disabled === false);

  // ---------------------------------------------------------------------
  // 2. Build from slip fails
  // ---------------------------------------------------------------------
  unhandled = 0;
  await click(buildButton());
  check("failed build: the failure is handled", unhandled === 0, `unhandled rejections=${unhandled}`);
  check('failed build: the button is back to "Build from slip", not stuck on "Building…"', buildLabel() === "Build from slip", `button="${buildLabel()}"`);
  check("failed build: the button can be pressed again", buildButton()?.disabled === false);
  check("failed build: an error is shown", text().includes(BUILD_ERROR));
  check("failed build: no parlay is shown", !text().includes("leg parlay"));

  // ---------------------------------------------------------------------
  // 3. The next try works, and clears the error
  // ---------------------------------------------------------------------
  recordsFail = false;
  await click(buildButton());
  check("retry: the parlay is built", text().includes("3-leg parlay"), `button="${buildButton()?.textContent}"`);
  check("retry: the error is gone", !text().includes(BUILD_ERROR));
  check("retry: the button is idle again", buildLabel() === "Build from slip" && buildButton()?.disabled === false);

  // Equal records: the legs come out by pick id, not in the slip's own order (p3, p1, p2).
  const heading = Array.from(container.querySelectorAll("h3")).find((el) => (el.textContent ?? "").includes("leg parlay"));
  // Each leg's capper link (its "Why this leg?" names the capper again).
  const legOrder = Array.from(heading?.parentElement?.querySelectorAll('a[href^="/cappers/"]') ?? [])
    .map((a) => a.textContent)
    .join();
  check("equal records: legs are ordered by pick id, not by the order they were added", legOrder === "Capper p1,Capper p2,Capper p3", legOrder);

  await act(() => root.unmount());
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
