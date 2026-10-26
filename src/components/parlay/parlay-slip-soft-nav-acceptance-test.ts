// Proof that the Parlay slip survives a league switch on /live, a refresh, and
// a confirm made while the slip is still being checked against the DB.
//
// The real ParlayPoolProvider, LiveBannerRow, ParlaySlipButton and PickCard are
// rendered on a jsdom document under a stand-in app router. A click on a link
// is followed the way a browser would: if the router took it (next/link), the
// same tree re-renders with the new league; if nothing took it (a plain <a>),
// the document is thrown away and a new one mounts, as a full page load does.
// localStorage is the jsdom window's own, so it outlives a "page load" here
// exactly as it does in a browser. Only the server action is replaced.
// Run: npx tsx src/components/parlay/parlay-slip-soft-nav-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// The stand-in for getSlipPickStatesAction. Each scenario sets `respond`.
let fetchCalls = 0;
let respond: (pickIds: string[]) => Promise<States> = async () => ({});
const actionPath = require.resolve("../../server/actions/parlay-slip");
require.cache[actionPath] = {
  id: actionPath,
  filename: actionPath,
  loaded: true,
  exports: {
    getSlipPickStatesAction: (pickIds: string[]) => {
      fetchCalls++;
      return respond(pickIds);
    },
  },
} as unknown as NodeJS.Module;

const FUTURE = "2099-01-01T00:00:00.000Z";
const pending = (ids: string[]): States =>
  Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, over: false, gameStatus: null }]));

const LEAGUES = [
  { key: "americanfootball_nfl", label: "NFL" },
  { key: "americanfootball_ncaaf", label: "NCAAF" },
  { key: "baseball_mlb", label: "MLB" },
];

function pick(pickId: string, leagueName: string): ExpanderPick {
  return {
    pickId, capperId: "capper-" + pickId, capperName: "Capper " + pickId, capperColorTag: null, capperIsFavorite: false,
    category: null, leagueName, gameId: "game-" + pickId, gameLabel: "Away @ Home", betDetail: "Home ML",
    odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: "Home ML", line: null,
    homeTeam: "Home", awayTeam: "Away", gameTime: FUTURE, teamGroup: "HOME", teamLabel: "Home", teamColor: null,
    datePosted: "2098-12-31T00:00:00.000Z",
  };
}
const BOARDS: Record<string, ExpanderPick[]> = {
  americanfootball_nfl: [pick("nfl1", "NFL"), pick("nfl2", "NFL")],
  americanfootball_ncaaf: [pick("ncaaf1", "NCAAF")],
  baseball_mlb: [pick("mlb1", "MLB")],
};

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/live" });
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
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { ParlayPoolProvider, useParlayPool, clearParlaySlips } = await import("./parlay-pool-context");
  const { ParlaySlipButton } = await import("./parlay-slip-button");
  const { TargetGameCheckbox } = await import("./target-game-checkbox");
  const { LiveBannerRow } = await import("../live/live-banner-row");
  const { PickCard } = await import("../live/pick-card");
  const h = React.createElement;
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // --- the page: banner (league chips, view toggle, slip button) over one league's board ---
  let userId = "";
  let at = { league: LEAGUES[0].key, view: "advanced" };
  let ctx!: ReturnType<typeof useParlayPool>;
  let providerMounts = 0;
  let routerNavs: string[] = [];
  let holdNav: (() => void) | null | false = false; // false: navigate at once; else the held navigation

  function Probe() {
    ctx = useParlayPool();
    React.useEffect(() => {
      providerMounts++;
    }, []);
    return null;
  }
  function Board({ league }: { league: string }) {
    // Each pick is on its own game; each game card carries "Target game" (slip mode only).
    return h(
      "div",
      { "data-board": league },
      BOARDS[league].map((p) =>
        h(
          "div",
          { key: p.pickId },
          h(TargetGameCheckbox, { game: { gameId: p.gameId, gameLabel: "Away @ Home " + p.gameId, gameTime: p.gameTime, leagueName: p.leagueName } }),
          h(PickCard, { pick: p, records: null, loading: false, selectable: true })
        )
      )
    );
  }
  function Page() {
    const leagues = LEAGUES.map((l) => ({ ...l, href: "/live?sport=" + l.key + "&view=" + at.view }));
    const views = [
      { key: "feed", label: "Feed", href: "/live?sport=" + at.league + "&view=feed" },
      { key: "advanced", label: "Grid", href: "/live?sport=" + at.league + "&view=advanced" },
    ];
    return h(
      ParlayPoolProvider,
      { key: userId, userId, children: null },
      h(Probe),
      h(LiveBannerRow, { leagues, league: at.league, views, view: at.view, children: h(ParlaySlipButton) }),
      h(Board, { key: at.league, league: at.league })
    );
  }

  let root: Root | null = null;
  let container: HTMLElement | null = null;
  const goTo = (href: string) => {
    const url = new URL(href, "http://localhost");
    at = { league: url.searchParams.get("sport") ?? at.league, view: url.searchParams.get("view") ?? at.view };
  };
  const router = {
    push: (href: string) => {
      routerNavs.push(href);
      const arrive = () => {
        goTo(href);
        root!.render(h(AppRouterContext.Provider, { value: router as never }, h(Page)));
      };
      if (holdNav === false) arrive();
      else holdNav = arrive;
    },
    replace: () => {},
    prefetch: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
  };
  // A new document: everything in memory is gone, localStorage is not.
  async function loadPage() {
    if (root) await act(() => root!.unmount());
    container?.remove();
    container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(h(AppRouterContext.Provider, { value: router as never }, h(Page)));
      await tick();
    });
  }
  async function start(user: string) {
    userId = user;
    at = { league: LEAGUES[0].key, view: "advanced" };
    providerMounts = 0;
    routerNavs = [];
    fetchCalls = 0;
    holdNav = false;
    await loadPage();
  }

  const $$ = <T extends Element>(sel: string) => Array.from(container!.querySelectorAll<T>(sel));
  const link = (label: string) => $$<HTMLAnchorElement>("a").find((a) => a.textContent === label)!;
  const button = (startsWith: string) => $$<HTMLButtonElement>("button").find((b) => (b.textContent ?? "").startsWith(startsWith));
  const slipLabel = () => button("Parlay slip")?.textContent ?? "(no slip button)";
  const barText = () => container!.querySelector('[role="toolbar"] span span')?.textContent ?? "(not in slip mode)";
  const box = (pickId: string) => $$<HTMLInputElement>("input[type=checkbox]").find((i) => (i.getAttribute("aria-label") ?? "").includes("Capper " + pickId + " "));
  const boardLeague = () => container!.querySelector("[data-board]")?.getAttribute("data-board");
  const poolIds = () => ctx.pool.map((p) => p.pickId).join(",");
  // A control that is not there is not clicked: the check after it fails, the run goes on.
  const click = (el: Element | undefined) => act(async () => {
    (el as HTMLElement | undefined)?.click();
    await tick();
  });
  // Clicks a link and does what the browser does next.
  async function follow(a: HTMLAnchorElement) {
    const href = a.getAttribute("href")!;
    const ev = new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      a.dispatchEvent(ev);
      await tick();
    });
    if (!ev.defaultPrevented) {
      goTo(href);
      await loadPage();
    }
  }

  // ---------------------------------------------------------------------
  // 1. Checked picks go straight into the slip; slip mode and the slip
  //    survive a league switch (client-side navigation)
  // ---------------------------------------------------------------------
  respond = async (ids) => pending(ids);
  await start("user-1");
  await click(button("Parlay slip"));
  check("slip mode on: the bar shows, no picks yet", ctx.slipMode && barText() === "0 picks · 0 games targeted", barText());
  await click(box("nfl1"));
  await click(box("nfl2"));
  check("checked picks go straight into the slip (no Confirm)", poolIds() === "nfl1,nfl2" && box("nfl1")!.checked && box("nfl2")!.checked && !button("Confirm"), poolIds());
  check("...and their games are targeted via the picks", barText() === "2 picks · 2 games targeted", barText());

  await follow(link("NCAAF"));
  check("NFL -> NCAAF: the board is NCAAF's", boardLeague() === "americanfootball_ncaaf", String(boardLeague()));
  check("NFL -> NCAAF: the router took the click (client-side navigation)", routerNavs.join() === "/live?sport=americanfootball_ncaaf&view=advanced", `routerNavs=[${routerNavs.join()}]`);
  check("NFL -> NCAAF: ParlayPoolProvider stayed mounted", providerMounts === 1, `mounts=${providerMounts}`);
  check("NFL -> NCAAF: still in slip mode, both picks in the slip", ctx.slipMode && poolIds() === "nfl1,nfl2", poolIds());

  await follow(link("NFL"));
  check("back on NFL: both checkboxes are still checked", box("nfl1")?.checked === true && box("nfl2")?.checked === true);

  await follow(link("Feed"));
  check("Grid -> Feed: the router took the click", routerNavs[routerNavs.length - 1] === "/live?sport=americanfootball_nfl&view=feed", `last=${routerNavs[routerNavs.length - 1]}`);
  check("Grid -> Feed: ParlayPoolProvider stayed mounted, picks still checked", providerMounts === 1 && box("nfl1")?.checked === true && box("nfl2")?.checked === true, `mounts=${providerMounts}`);

  // ---------------------------------------------------------------------
  // 2. Unchecking removes; picks from more than one league survive a switch
  // ---------------------------------------------------------------------
  await click(box("nfl2"));
  check("unchecking a pick takes it out of the slip", poolIds() === "nfl1" && box("nfl2")?.checked === false, poolIds());
  await follow(link("NCAAF"));
  await click(box("ncaaf1"));
  check("setup: picks from NFL and NCAAF", poolIds() === "nfl1,ncaaf1", poolIds());

  const callsBefore = fetchCalls;
  await follow(link("MLB"));
  check("NCAAF -> MLB: both picks remain", poolIds() === "nfl1,ncaaf1" && barText().startsWith("2 picks"), `${poolIds()} / ${barText()}`);
  check("NCAAF -> MLB: ParlayPoolProvider stayed mounted, slip not re-read from storage", providerMounts === 1 && fetchCalls === callsBefore, `mounts=${providerMounts} fetchCalls=${fetchCalls - callsBefore}`);

  // The clicked chip lights before the server answers.
  holdNav = null;
  await follow(link("NFL"));
  const lit = (label: string) => link(label).className.includes("bg-[#2563EB]");
  check("a clicked chip lights at once, before the new board arrives", lit("NFL") && !lit("MLB") && boardLeague() === "baseball_mlb", `board=${boardLeague()}`);
  const arrive = holdNav as (() => void) | null;
  holdNav = false;
  if (arrive) await act(async () => arrive());
  check("...and is the current page once it does", boardLeague() === "americanfootball_nfl" && link("NFL").getAttribute("aria-current") === "page" && lit("NFL"));

  // ---------------------------------------------------------------------
  // 3. Target game: a game with no pick can be targeted; a picked game is
  //    targeted via the pick and can't be unchecked
  // ---------------------------------------------------------------------
  const targetBox = (gameId: string) => $$<HTMLInputElement>("input[type=checkbox]").find((i) => (i.getAttribute("aria-label") ?? "").endsWith("Away @ Home " + gameId));
  check("the picked game: 'Targeted via your picks', checked and locked", targetBox("game-nfl1")?.checked === true && targetBox("game-nfl1")?.disabled === true && (targetBox("game-nfl1")?.getAttribute("aria-label") ?? "").startsWith("Targeted via your picks"));
  await click(targetBox("game-nfl2"));
  check("a game with no pick in the slip can be targeted on its own", ctx.targets.map((t) => t.gameId).join() === "game-nfl2" && barText() === "2 picks · 3 games targeted", barText());
  await click(targetBox("game-nfl2"));
  check("...and untargeted", ctx.targets.length === 0);

  // ---------------------------------------------------------------------
  // 4. Exit, refresh, and Send to generator turn slip mode off - and it
  //    stays off (it used to come back on Live after sending)
  // ---------------------------------------------------------------------
  await click(button("Exit"));
  check("Exit: slip mode off, the slip kept", !ctx.slipMode && poolIds() === "nfl1,ncaaf1" && slipLabel() === "Parlay slip · 2" && box("nfl1") === undefined, slipLabel());
  await click(button("Parlay slip"));
  await loadPage();
  check("refresh: the page really reloaded", providerMounts === 2, `mounts=${providerMounts}`);
  check("refresh: the slip is back, slip mode is not", poolIds() === "nfl1,ncaaf1" && !ctx.slipMode && box("nfl1") === undefined, poolIds());

  await click(button("Parlay slip"));
  const send = link("Send to generator →");
  check("slip mode: 'Send to generator →' links to /parlay", send?.getAttribute("href") === "/parlay");
  await follow(send);
  check("Send to generator: slip mode off, the router went to /parlay", !ctx.slipMode && routerNavs[routerNavs.length - 1] === "/parlay", `last=${routerNavs[routerNavs.length - 1]}`);
  await follow(link("NFL"));
  check("back on Live after sending: no checkboxes, the slip kept", box("nfl1") === undefined && slipLabel() === "Parlay slip · 2" && poolIds() === "nfl1,ncaaf1", slipLabel());

  await act(() => clearParlaySlips());
  check("sign-out clears the stored slip", win.localStorage.getItem("parlay-pool:user-1") === null);

  // ---------------------------------------------------------------------
  // 5. A pick checked while the stored slip is still being checked
  // ---------------------------------------------------------------------
  const A = pick("stored1", "NFL");
  const seed = (user: string) => win.localStorage.setItem("parlay-pool:" + user, JSON.stringify({ pool: [A], leagueScope: { NFL: true }, legCount: 2 }));
  let settle: { resolve: (s: States) => void; reject: (e: Error) => void };
  const held = () => new Promise<States>((resolve, reject) => (settle = { resolve, reject }));

  // 5a. the check comes back: the stored pick and the new one are both there
  seed("user-4a");
  respond = held;
  await start("user-4a");
  check("setup: the stored slip is not shown until it has been checked", poolIds() === "" && fetchCalls === 1, `pool=${poolIds()} fetchCalls=${fetchCalls}`);
  await click(button("Parlay slip"));
  await click(box("nfl1"));
  check("setup: a pick added while the check is in flight", poolIds() === "nfl1", poolIds());
  await act(async () => {
    settle.resolve(pending(["stored1"]));
    await tick();
  });
  check("added during hydrate: the new pick is kept alongside the stored one", poolIds() === "stored1,nfl1", poolIds());
  respond = async (ids) => pending(ids);
  await loadPage();
  check("...and both are saved", poolIds() === "stored1,nfl1", poolIds());

  // 5b. the check fails (offline): same
  seed("user-4b");
  respond = held;
  await start("user-4b");
  await click(button("Parlay slip"));
  await click(box("nfl1"));
  await act(async () => {
    settle.reject(new Error("offline"));
    await tick();
  });
  check("added during hydrate, check failed: the new pick is kept alongside the stored one", poolIds() === "stored1,nfl1", poolIds());

  // 5c. a stored pick the check prunes is not brought back by a re-check meanwhile
  win.localStorage.setItem("parlay-pool:user-4c", JSON.stringify({ pool: [BOARDS.americanfootball_nfl[0]], leagueScope: { NFL: true }, legCount: 2 }));
  respond = held;
  await start("user-4c");
  await click(button("Parlay slip"));
  await click(box("nfl1"));
  await click(box("nfl2"));
  await act(async () => {
    settle.resolve({ nfl1: { status: "WIN", odds: -110, kickoff: FUTURE, over: true, gameStatus: null } });
    await tick();
  });
  check("added during hydrate: a stored pick that has since been graded is still pruned, and said quietly", poolIds() === "nfl2" && ctx.removed?.picks.map((p) => p.pickId + ":" + p.result).join() === "nfl1:Won", `pool=${poolIds()} removed=${JSON.stringify(ctx.removed)}`);

  await act(() => root!.unmount());

  // ---------------------------------------------------------------------
  // 5. /parlay's links to Live (the generator card: read, not rendered)
  // ---------------------------------------------------------------------
  const card = readFileSync(join(__dirname, "generator-card.tsx"), "utf8");
  check(
    '/parlay: "+ Add picks from Live" and "+ Add games from Live" are next/links, not plain <a>',
    /<Link href="\/live"[^>]*>\s*\+ Add picks from Live/.test(card) && /<Link href="\/live"[^>]*>\s*\+ Add games from Live/.test(card) && !/<a href="\/live"/.test(card)
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
