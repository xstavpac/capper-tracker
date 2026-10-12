// Proof that the Parlay Generator's UI holds the 20-leg cap, and says so:
// Auto-Generate's stepper reaches 20 and answers a 21st with "20 legs max";
// the Parlay slip takes 20 picks and refuses a Confirm that would make 21
// (adding none of them, keeping the ticks); My Picks builds a 20-leg parlay
// and its stepper answers a 21st the same way; and a "20 legs max" refusal
// from either server action is shown as that, not as a generic failure.
//
// The real AutoGenerateSection, ParlayPoolProvider, ParlaySlipButton,
// ParlayPoolSection and PickCard are rendered on a jsdom document. Only the
// server actions are replaced. The numbers are written out here on purpose,
// not imported from lib/parlay/leg-cap.ts: this file states the rule, the
// code has to meet it. The server actions' own enforcement is proved in
// src/server/actions/parlay-leg-cap-acceptance-test.ts.
// Run: npx tsx src/components/parlay/parlay-leg-cap-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { SlipPickState } from "@/server/actions/parlay-slip";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const CAP = 20;
const CAP_MESSAGE = "20 legs max";

type States = Record<string, SlipPickState>;
const FUTURE = "2099-01-01T00:00:00.000Z";
const pending = (ids: string[]): States =>
  Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, started: false }]));

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
// One pick in each of 25 games, so no two can conflict.
const PICKS = Array.from({ length: 25 }, (_, i) => pick(i + 1));
const NO_RECORDS = { records: {}, streaks: {}, last20: {} };

// --- stand-ins for the server actions ---
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
let respondSlip: (pickIds: string[]) => Promise<States> = async (ids) => pending(ids);
stub("../../server/actions/parlay-slip", { getSlipPickStatesAction: (ids: string[]) => respondSlip(ids) });
stub("../../server/actions/picks", { getLeagueRecordsAction: async () => NO_RECORDS });

const autoCalls: number[] = [];
let autoRejects = false;
stub("../../server/actions/parlay-generator", {
  autoGenerateParlayAction: async (_leagues: string[], legCount: number) => {
    autoCalls.push(legCount);
    if (autoRejects) return { error: CAP_MESSAGE };
    const legs = PICKS.slice(0, legCount).map((p) => ({
      gameId: p.gameId, gameLabel: p.gameLabel, gameTime: p.gameTime, top: { pick: p, record: null }, next: [],
    }));
    return {
      parlayA: { requested: legCount, available: PICKS.length, legs },
      hedge: { mode: "AUTO_HEDGE", legs: [] },
      contrarian: { mode: "CONTRARIAN", legs: [] },
      records: NO_RECORDS,
      leaguesSearched: ["MLB"],
    };
  },
});
const swapCalls: { picks: number; legCount: number; mode: string }[] = [];
stub("../../server/actions/parlay-pool-generator", {
  generatePoolSwapAction: async (pickIds: string[], legCount: number, mode: string) => {
    swapCalls.push({ picks: pickIds.length, legCount, mode });
    return { error: CAP_MESSAGE };
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

  const React = await import("react");
  // tsx compiles the components' JSX to React.createElement (tsconfig "jsx": "preserve"), with no import of its own.
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { ParlayPoolProvider, useParlayPool } = await import("./parlay-pool-context");
  const { ParlaySlipButton } = await import("./parlay-slip-button");
  const { ParlayPoolSection } = await import("./parlay-pool-section");
  const { AutoGenerateSection } = await import("./auto-generate-section");
  const { PickCard } = await import("../live/pick-card");
  const h = React.createElement;
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());
  const tick = () => new Promise((r) => setTimeout(r, 0));

  let root: Root | null = null;
  let container: HTMLElement | null = null;
  async function mount(tree: React.ReactNode) {
    if (root) await act(() => root!.unmount());
    container?.remove();
    container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(tree);
      await tick();
    });
  }

  const $$ = <T extends Element>(sel: string) => Array.from(container!.querySelectorAll<T>(sel));
  const button = (startsWith: string) => $$<HTMLButtonElement>("button").find((b) => (b.textContent ?? "").startsWith(startsWith));
  const more = () => $$<HTMLButtonElement>('button[aria-label="More legs"]')[0];
  const fewer = () => $$<HTMLButtonElement>('button[aria-label="Fewer legs"]')[0];
  const legs = () => Number(more()?.previousElementSibling?.textContent);
  const alerts = () => $$('[role="alert"]').map((el) => el.textContent ?? "");
  const says = (text: string) => (container!.textContent ?? "").includes(text);
  const box = (n: number) => $$<HTMLInputElement>("input[type=checkbox]").find((i) => (i.getAttribute("aria-label") ?? "").includes("Capper p" + n + " "));
  // A control that is not there, or is disabled, is not clicked: the check after it fails, the run goes on.
  const click = (el: Element | undefined) => act(async () => {
    (el as HTMLElement | undefined)?.click();
    await tick();
  });
  async function clickTimes(el: () => Element | undefined, times: number) {
    for (let i = 0; i < times; i++) await click(el());
  }

  // ---------------------------------------------------------------------
  // 1. Auto-Generate: the stepper reaches 20, and a 21st is answered
  // ---------------------------------------------------------------------
  await mount(h(AutoGenerateSection, { leagues: ["MLB"] }));
  check("Auto-Generate: starts at 3 legs", legs() === 3, `legs=${legs()}`);
  await clickTimes(more, CAP - 3);
  check("Auto-Generate: the stepper reaches 20", legs() === CAP, `legs=${legs()}`);
  check("Auto-Generate: no limit message at 20", !says(CAP_MESSAGE));

  await click(button("Auto-Generate"));
  check("Auto-Generate: asks the server for 20 legs", autoCalls.join() === String(CAP), `calls=[${autoCalls.join()}]`);
  check("Auto-Generate: the 20-leg parlay is shown", says("Parlay A — 20-leg parlay"));

  await click(more());
  check("Auto-Generate: a 21st leg is not added", legs() === CAP, `legs=${legs()}`);
  check('Auto-Generate: a 21st leg shows "20 legs max"', alerts().includes(CAP_MESSAGE), `alerts=[${alerts().join()}]`);
  check("Auto-Generate: the server was never asked for 21", !autoCalls.some((n) => n > CAP), `calls=[${autoCalls.join()}]`);
  await click(fewer());
  check("Auto-Generate: stepping back to 19 clears the message", legs() === CAP - 1 && !says(CAP_MESSAGE), `legs=${legs()}`);

  autoRejects = true;
  await click(button("Auto-Generate"));
  check('Auto-Generate: a "20 legs max" refusal from the server is shown as that', says(CAP_MESSAGE) && !says("leg parlay"), `text has message=${says(CAP_MESSAGE)}`);

  // ---------------------------------------------------------------------
  // 2. The Parlay slip: 20 picks go in, a Confirm that would make 21 does not
  // ---------------------------------------------------------------------
  let ctx!: ReturnType<typeof useParlayPool>;
  function Probe() {
    ctx = useParlayPool();
    return null;
  }
  const page = (userId: string) =>
    h(
      ParlayPoolProvider,
      { key: userId, userId, children: null },
      h(Probe),
      h(ParlaySlipButton),
      h("div", { "data-board": true }, PICKS.map((p) => h(PickCard, { key: p.pickId, pick: p, records: null, loading: false, selectable: true }))),
      h(ParlayPoolSection)
    );
  const tickPicks = async (from: number, to: number) => {
    for (let n = from; n <= to; n++) await click(box(n));
  };

  await mount(page("user-1"));
  await click(button("Parlay slip"));
  await tickPicks(1, CAP);
  await click(button("Confirm"));
  check("slip: 20 picks confirmed", ctx.pool.length === CAP && !ctx.addMode, `pool=${ctx.pool.length}`);
  check("slip: no limit message at 20", !says(CAP_MESSAGE));

  await click(button("Parlay slip"));
  await click(box(21));
  await click(button("Confirm"));
  check("slip: a 21st pick is not added", ctx.pool.length === CAP, `pool=${ctx.pool.length}`);
  check('slip: a 21st pick shows "20 legs max"', alerts().some((a) => a.includes(CAP_MESSAGE)), `alerts=[${alerts().join()}]`);
  check("slip: the refused pick is still ticked, still in add mode", ctx.addMode && ctx.checkedPicks.has("p21") && box(21)?.checked === true);
  await click(button("OK"));
  check("slip: dismissing the message keeps the selection", !says(CAP_MESSAGE) && ctx.addMode && ctx.checkedPicks.has("p21"));
  await click(box(21));
  await click(button("Parlay slip"));
  check("setup: add mode left with nothing ticked", !ctx.addMode && ctx.pool.length === CAP);

  // ---------------------------------------------------------------------
  // 3. My Picks: a 20-leg parlay builds, and its stepper answers a 21st
  // ---------------------------------------------------------------------
  check("My Picks: starts at 2 legs of 20 in-scope picks", legs() === 2 && ctx.maxLegCount === CAP, `legs=${legs()} max=${ctx.maxLegCount}`);
  await clickTimes(more, CAP - 2);
  check("My Picks: the stepper reaches 20", legs() === CAP && ctx.legCount === CAP, `legs=${legs()}`);
  await click(button("Build My Picks"));
  check("My Picks: the 20-leg parlay is built", says("20-leg parlay"));
  check("My Picks: no limit message at 20", !says(CAP_MESSAGE));

  await click(more());
  check("My Picks: a 21st leg is not added", legs() === CAP && ctx.legCount === CAP, `legs=${legs()}`);
  check('My Picks: a 21st leg shows "20 legs max"', alerts().includes(CAP_MESSAGE), `alerts=[${alerts().join()}]`);

  // ---------------------------------------------------------------------
  // 4. One Confirm of 21 ticks adds none of them (no trimming to 20)
  // ---------------------------------------------------------------------
  await mount(page("user-2"));
  await click(button("Parlay slip"));
  await tickPicks(1, CAP + 1);
  await click(button("Confirm"));
  check("21 ticked at once: none are added", ctx.pool.length === 0 && ctx.addMode && ctx.checkedPicks.size === CAP + 1, `pool=${ctx.pool.length} ticked=${ctx.checkedPicks.size}`);
  check('21 ticked at once: shows "20 legs max" and how many to untick', alerts().some((a) => a.includes(CAP_MESSAGE) && a.includes("untick 1")), `alerts=[${alerts().join()}]`);
  await click(box(21));
  check("21 ticked at once: unticking one clears the message", !says(CAP_MESSAGE));
  await click(button("Confirm"));
  check("...and the 20 that remain confirm", ctx.pool.length === CAP && !ctx.addMode, `pool=${ctx.pool.length}`);

  // ---------------------------------------------------------------------
  // 5. Stored legs still being checked count toward the cap
  // ---------------------------------------------------------------------
  win.localStorage.setItem("parlay-pool:user-3", JSON.stringify({ pool: PICKS.slice(0, 19), leagueScope: { MLB: true }, legCount: 2 }));
  let settle!: (s: States) => void;
  respondSlip = () => new Promise<States>((resolve) => (settle = resolve));
  await mount(page("user-3"));
  check("setup: 19 stored legs, not shown until checked", ctx.pool.length === 0);
  await click(button("Parlay slip"));
  await tickPicks(20, 21);
  await click(button("Confirm"));
  check('confirm during hydrate: 19 stored + 2 new is refused with "20 legs max"', ctx.pool.length === 0 && ctx.addMode && alerts().some((a) => a.includes(CAP_MESSAGE)), `pool=${ctx.pool.length} alerts=[${alerts().join()}]`);
  await act(async () => {
    settle(pending(PICKS.slice(0, 19).map((p) => p.pickId)));
    await tick();
  });
  check("...and the slip is the 19 stored legs", ctx.pool.length === 19, `pool=${ctx.pool.length}`);
  await click(box(21));
  await click(button("Confirm"));
  check("...and one more makes 20", ctx.pool.length === CAP && !ctx.addMode, `pool=${ctx.pool.length}`);
  respondSlip = async (ids) => pending(ids);

  // ---------------------------------------------------------------------
  // 6. A slip saved before the cap existed is kept whole, but builds at most 20
  // ---------------------------------------------------------------------
  win.localStorage.setItem("parlay-pool:user-4", JSON.stringify({ pool: PICKS.slice(0, 24), leagueScope: { MLB: true }, legCount: 24 }));
  await mount(page("user-4"));
  check("oversized stored slip: no pick is dropped", ctx.pool.length === 24, `pool=${ctx.pool.length}`);
  check("oversized stored slip: the leg count stops at 20", ctx.maxLegCount === CAP && ctx.legCount === CAP && legs() === CAP, `max=${ctx.maxLegCount} legCount=${ctx.legCount}`);
  await click(button("Parlay slip"));
  await click(box(25));
  await click(button("Confirm"));
  check('oversized stored slip: adding to it is refused with "20 legs max"', ctx.pool.length === 24 && alerts().some((a) => a.includes(CAP_MESSAGE)), `pool=${ctx.pool.length}`);
  await click(box(25));
  await click(button("Parlay slip"));

  // ---------------------------------------------------------------------
  // 7. Auto Hedge / Contrarian: 20 legs are sent, and a refusal is shown
  // ---------------------------------------------------------------------
  await mount(page("user-1")); // the 20-pick slip from 2, read back from storage
  await clickTimes(more, CAP);
  await click(button("Auto Hedge"));
  await click(button("Contrarian"));
  check(
    "Auto Hedge and Contrarian each ask the server for 20 legs from the 20-pick slip",
    JSON.stringify(swapCalls) === JSON.stringify([{ picks: CAP, legCount: CAP, mode: "AUTO_HEDGE" }, { picks: CAP, legCount: CAP, mode: "CONTRARIAN" }]),
    JSON.stringify(swapCalls)
  );
  const shown = $$("p").filter((p) => p.textContent === CAP_MESSAGE).length;
  check('a "20 legs max" refusal from the server is shown for each, as that', shown === 2, `shown=${shown}`);

  await act(() => root!.unmount());
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
