// Proof of the Parlay Generator's league-scope defaults.
//
// My Picks (the slip's scope): confirming a pick from a league switches that
// league on; a league that already has picks in a stored slip starts on; a
// league the user switched off stays off - through other adds and a reload -
// until a new pick from that league is added.
//
// Auto-Generate: every league starts on, any can be switched off, and its
// "nothing found" line says "this week" for the football leagues.
//
// The real ParlayPoolProvider, ParlaySlipButton, ParlayPoolSection,
// AutoGenerateSection and PickCard are rendered on a jsdom document. Only the
// server actions are replaced.
// Run: npx tsx src/components/parlay/parlay-scope-defaults-acceptance-test.ts
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

type States = Record<string, SlipPickState>;
const FUTURE = "2099-01-01T00:00:00.000Z";
const pending = (ids: string[]): States =>
  Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, started: false }]));

function pick(id: string, leagueName: string): ExpanderPick {
  const home = "Home " + id;
  const away = "Away " + id;
  return {
    pickId: id, capperId: "capper-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false,
    category: null, leagueName, gameId: "game-" + id, gameLabel: away + " @ " + home, betDetail: home + " ML",
    odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: home + " ML", line: null,
    homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: home, teamColor: null,
    datePosted: "2098-12-31T00:00:00.000Z",
  };
}
const MLB1 = pick("mlb1", "MLB");
const MLB2 = pick("mlb2", "MLB");
const NFL1 = pick("nfl1", "NFL");
const NFL2 = pick("nfl2", "NFL");
const NBA1 = pick("nba1", "NBA");
const BOARD = [MLB1, MLB2, NFL1, NFL2, NBA1];
const NO_RECORDS = { records: {}, streaks: {}, last20: {} };

// --- stand-ins for the server actions ---
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-slip", { getSlipPickStatesAction: async (ids: string[]) => pending(ids) });
stub("../../server/actions/picks", { getLeagueRecordsAction: async () => NO_RECORDS });
stub("../../server/actions/parlay-pool-generator", { generatePoolSwapAction: async () => ({ error: "not used" }) });

const autoCalls: string[][] = [];
stub("../../server/actions/parlay-generator", {
  // Finds nothing: what is under test is which leagues were asked for and how
  // the empty result is worded.
  autoGenerateParlayAction: async (leagues: string[], legCount: number) => {
    autoCalls.push(leagues);
    return {
      parlayA: { requested: legCount, available: 0, legs: [] },
      hedge: { mode: "AUTO_HEDGE", legs: [], swapCount: 0 },
      contrarian: { mode: "CONTRARIAN", legs: [], swapCount: 0 },
      records: NO_RECORDS,
      leaguesSearched: leagues,
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
  const says = (text: string) => (container!.textContent ?? "").replace(/\s+/g, " ").includes(text);
  const box = (p: ExpanderPick) => $$<HTMLInputElement>("input[type=checkbox]").find((i) => (i.getAttribute("aria-label") ?? "").includes(p.capperName + " "));
  // A league's switch, found by the league name in its label. `kind` tells My Picks' chips ("picks") from Auto-Generate's ("games").
  const chip = (league: string, kind: "picks" | "games") =>
    $$<HTMLButtonElement>('button[role="switch"]').find((b) => (b.getAttribute("aria-label") ?? "").includes(" " + league + " " + kind + " "));
  const isOn = (league: string, kind: "picks" | "games") => chip(league, kind)?.getAttribute("aria-checked") === "true";
  const click = (el: Element | undefined) => act(async () => {
    (el as HTMLElement | undefined)?.click();
    await tick();
  });

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
      h("div", { "data-board": true }, BOARD.map((p) => h(PickCard, { key: p.pickId, pick: p, records: null, loading: false, selectable: true }))),
      h(ParlayPoolSection)
    );
  async function add(...picks: ExpanderPick[]) {
    await click(button("Parlay slip"));
    for (const p of picks) await click(box(p));
    await click(button("Confirm"));
  }
  const stored = (userId: string) => JSON.parse(win.localStorage.getItem("parlay-pool:" + userId) ?? "{}");

  // ---------------------------------------------------------------------
  // 1. Adding a pick switches its league on
  // ---------------------------------------------------------------------
  await mount(page("user-1"));
  await add(NFL1);
  check("setup: the NFL pick is in the slip", ctx.pool.length === 1 && ctx.pool[0].pickId === "nfl1", `pool=${ctx.pool.length}`);
  check("adding an NFL pick turns NFL on", ctx.isLeagueInScope("NFL") && isOn("NFL", "picks"), `inScope=${ctx.isLeagueInScope("NFL")} chip=${isOn("NFL", "picks")}`);
  check("...so it counts toward the build", ctx.maxLegCount === 1, `max=${ctx.maxLegCount}`);

  await add(MLB1, NBA1);
  check(
    "MLB and NBA picks turn those leagues on too: all three are on",
    ["MLB", "NFL", "NBA"].every((l) => ctx.isLeagueInScope(l) && isOn(l, "picks")) && ctx.maxLegCount === 3,
    `max=${ctx.maxLegCount}`
  );

  // ---------------------------------------------------------------------
  // 2. A league the user switched off stays off until a new pick from it
  // ---------------------------------------------------------------------
  await click(chip("NFL", "picks"));
  check("switching NFL off takes it out", !ctx.isLeagueInScope("NFL") && !isOn("NFL", "picks") && ctx.maxLegCount === 2, `max=${ctx.maxLegCount}`);

  await add(MLB2);
  check("adding a pick from another league leaves NFL off", !ctx.isLeagueInScope("NFL") && ctx.pool.length === 4 && ctx.maxLegCount === 3, `max=${ctx.maxLegCount}`);

  // Ticking a pick already in the slip adds nothing, so it is not a new pick.
  await click(button("Parlay slip"));
  check("setup: the NFL pick already in the slip can't be ticked again", box(NFL1) === undefined || box(NFL1)!.disabled || ctx.isInPool("nfl1"));
  await click(button("Parlay slip"));

  check("the switched-off league is saved with the slip", JSON.stringify(stored("user-1").excludedLeagues) === '["NFL"]', JSON.stringify(stored("user-1").excludedLeagues));
  await mount(page("user-1")); // a reload: the slip is read back from storage
  check(
    "after a reload NFL is still off, MLB and NBA still on",
    ctx.pool.length === 4 && !ctx.isLeagueInScope("NFL") && !isOn("NFL", "picks") && isOn("MLB", "picks") && isOn("NBA", "picks"),
    `pool=${ctx.pool.length} nfl=${ctx.isLeagueInScope("NFL")}`
  );

  await add(NFL2);
  check("a new NFL pick turns NFL back on", ctx.isLeagueInScope("NFL") && isOn("NFL", "picks") && ctx.maxLegCount === 5, `max=${ctx.maxLegCount}`);
  check("...and nothing is saved as switched off", JSON.stringify(stored("user-1").excludedLeagues) === "[]", JSON.stringify(stored("user-1").excludedLeagues));

  await click(chip("NBA", "picks"));
  await click(chip("NBA", "picks"));
  check("a league switched off can be switched back on by hand", ctx.isLeagueInScope("NBA") && isOn("NBA", "picks"));

  // ---------------------------------------------------------------------
  // 3. On load, a league that already has picks in the slip starts on
  // ---------------------------------------------------------------------
  // A slip saved by the old code: NFL and NBA were written "off" by the
  // MLB-only default, not by the user.
  win.localStorage.setItem(
    "parlay-pool:user-2",
    JSON.stringify({ pool: [MLB1, NFL1, NBA1], leagueScope: { MLB: true, NFL: false, NBA: false }, legCount: 2 })
  );
  await mount(page("user-2"));
  check(
    "stored slip with MLB, NFL and NBA picks: all three start on",
    ctx.pool.length === 3 && ["MLB", "NFL", "NBA"].every((l) => ctx.isLeagueInScope(l) && isOn(l, "picks")) && ctx.maxLegCount === 3,
    `pool=${ctx.pool.length} on=${["MLB", "NFL", "NBA"].filter((l) => ctx.isLeagueInScope(l)).join()} max=${ctx.maxLegCount}`
  );

  // ---------------------------------------------------------------------
  // 4. Auto-Generate: every league starts on
  // ---------------------------------------------------------------------
  const LEAGUES = ["MLB", "NFL", "NCAAF", "NBA", "NHL"];
  await mount(h(AutoGenerateSection, { leagues: LEAGUES }));
  check("Auto-Generate: every league starts on", LEAGUES.every((l) => isOn(l, "games")), `on=${LEAGUES.filter((l) => isOn(l, "games")).join()}`);
  await click(button("Generate parlay"));
  check("Auto-Generate: asks the server for every league", autoCalls.length === 1 && autoCalls[0].join() === LEAGUES.join(), `calls=${JSON.stringify(autoCalls)}`);
  check(
    "Auto-Generate: with daily and football leagues, the empty line names both windows",
    says("No games left today (this week for NFL, NCAAF) with picks from your cappers in MLB, NFL, NCAAF, NBA, NHL."),
    container!.textContent?.match(/No games left[^.]*\./)?.[0] ?? "no empty line"
  );

  await click(chip("NBA", "games"));
  await click(chip("NHL", "games"));
  await click(chip("MLB", "games"));
  check("Auto-Generate: a league can still be switched off", !isOn("NBA", "games") && !isOn("NHL", "games") && !isOn("MLB", "games") && isOn("NFL", "games") && isOn("NCAAF", "games"));
  await click(button("Generate parlay"));
  check("Auto-Generate: only the leagues left on are asked for", autoCalls[1]?.join() === "NFL,NCAAF", `calls=${JSON.stringify(autoCalls[1])}`);
  check(
    'Auto-Generate: football only, the empty line says "this week", not "today"',
    says("No games left this week with picks from your cappers in NFL, NCAAF.") && !says("today with picks"),
    container!.textContent?.match(/No games left[^.]*\./)?.[0] ?? "no empty line"
  );

  await click(chip("MLB", "games"));
  await click(chip("NFL", "games"));
  await click(chip("NCAAF", "games"));
  await click(button("Generate parlay"));
  check(
    'Auto-Generate: MLB only, the empty line still says "today"',
    autoCalls[2]?.join() === "MLB" && says("No games left today with picks from your cappers in MLB."),
    container!.textContent?.match(/No games left[^.]*\./)?.[0] ?? "no empty line"
  );

  await act(() => root!.unmount());
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
