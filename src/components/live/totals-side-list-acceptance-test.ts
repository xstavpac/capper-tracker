// Proof that the Totals group shows Over and Under as two separate labelled
// blocks in ONE column - in Feed Live's expander (GamePicksExpander, which the
// MLB/NFL game page also renders) and in Grid Live's panel (GameDetailPanel) -
// and that nothing else about the picks changes: every pick is still there
// once, as its own card, and the team and Other markets groups are not split.
//
// The real components are rendered on a jsdom document; only the two server
// actions they call are replaced.
// Run: npx tsx src/components/live/totals-side-list-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { JSDOM } from "jsdom";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { groupTotalsBySide, sortTotalsPicks } from "@/lib/pick-team-group";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
function expect(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, a === e ? "" : `got ${a}, expected ${e}`);
}

function replaceModule(path: string, exports: Record<string, unknown>) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as unknown as NodeJS.Module;
}
replaceModule("../../server/actions/picks", { getLeagueRecordsAction: async () => ({ records: {}, streaks: {}, last20: {} }) });
// The Parlay slip provider the pick cards sit under checks its (empty) slip against the DB.
replaceModule("../../server/actions/parlay-slip", { getSlipPickStatesAction: async () => ({}) });

const FUTURE = "2099-01-01T00:00:00.000Z";
function pick(pickId: string, over: Partial<ExpanderPick>): ExpanderPick {
  return {
    pickId, capperId: "capper-" + pickId, capperName: "Capper " + pickId, capperColorTag: null, capperIsFavorite: false,
    category: null, leagueName: "MLB", gameId: "g1", gameLabel: "Pirates @ Cubs", betDetail: "Cubs ML",
    odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: "Cubs ML", line: null,
    homeTeam: "Chicago Cubs", awayTeam: "Pittsburgh Pirates", gameTime: FUTURE, teamGroup: "HOME", teamLabel: "Cubs", teamColor: null,
    ...over,
  };
}
const total = (pickId: string, text: string, more: Partial<ExpanderPick> = {}) =>
  pick(pickId, { betType: "TOTAL", teamGroup: "TOTALS", teamLabel: "", betDetail: text, rawBetDetail: text, line: 8.5, ...more });

// Posted interleaved, the way a day's picks arrive.
const PICKS: ExpanderPick[] = [
  total("u1", "Under 8.5"),
  total("o1", "Over 8.5"),
  pick("home1", {}),
  total("u2", "Cubs Team Total Under 4.5", { betType: "TEAM_TOTAL" }),
  total("o2", "F5 Over 4.5", { period: "FIRST_5_INNINGS" }),
  pick("away1", { teamGroup: "AWAY", teamLabel: "Pirates", betDetail: "Pirates ML", rawBetDetail: "Pirates ML" }),
  total("u3", "F5 Under 4.5", { period: "FIRST_5_INNINGS" }),
  pick("prop1", { betType: "PLAYER_PROP", teamGroup: "OTHER", teamLabel: "", betDetail: "Skenes Over 6.5 Ks", rawBetDetail: "Skenes Over 6.5 Ks" }),
];

console.log("########## 1. groupTotalsBySide ##########");
{
  const totals = sortTotalsPicks(PICKS.filter((p) => p.teamGroup === "TOTALS"));
  const groups = groupTotalsBySide(totals);
  expect("Over block first, then Under", groups.map((g) => [g.side, g.label, g.tag]), [["OVER", "Over", "O"], ["UNDER", "Under", "U"]]);
  expect("each block keeps the Totals order (full game, period, team total)", groups.map((g) => g.picks.map((p) => p.pickId)), [["o1", "o2"], ["u1", "u3", "u2"]]);
  expect("only one side posted: one block", groupTotalsBySide([total("x", "Under 9")]).map((g) => g.side), ["UNDER"]);
  expect(
    "text naming neither side: a trailing unlabelled block, not guessed",
    groupTotalsBySide([total("x", "Total 9"), total("y", "Over 9")]).map((g) => [g.side, g.label, g.picks.length]),
    [["OVER", "Over", 1], [null, null, 1]]
  );
  expect("the stored text decides when the display label differs", groupTotalsBySide([total("x", "Total 9", { rawBetDetail: "under 9 runs" })]).map((g) => g.side), ["UNDER"]);
  expect("no picks: no blocks", groupTotalsBySide([]), []);
}

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/live" });
  const win = dom.window;
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.self = win;
  g.document = win.document;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const React = await import("react");
  // tsx compiles the components' JSX to React.createElement (tsconfig "jsx": "preserve"), with no import of its own.
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { ParlayPoolProvider, useParlayPool } = await import("../parlay/parlay-pool-context");
  const { GamePicksExpander } = await import("./game-picks-expander");
  const { GameDetailPanel } = await import("./team-picks-panel");
  const { buildGridLiveGamePanelData } = await import("./grid-live-team-panel-data");
  const h = React.createElement;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const router = { push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {}, forward: () => {} };

  let ctx!: ReturnType<typeof useParlayPool>;
  function Probe() {
    ctx = useParlayPool();
    return null;
  }

  async function mount(view: React.ReactElement) {
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(h(AppRouterContext.Provider, { value: router as never }, h(ParlayPoolProvider, { userId: "u", children: null }, h(Probe), view)));
      await tick();
    });
    return { container, root };
  }
  const click = (el: Element | null | undefined) =>
    React.act(async () => {
      (el as HTMLElement | null | undefined)?.click();
      await tick();
    });

  // What both views must show for PICKS.
  async function checkTotalsColumn(name: string, container: HTMLElement) {
    const columns = Array.from(container.querySelectorAll("[data-totals-column]"));
    expect(name + ": one Totals column", columns.length, 1);
    const column = columns[0];
    if (!column) return;
    const blocks = Array.from(column.children);
    expect(name + ": Over and Under are separate blocks, both direct children of that one column", blocks.map((b) => b.getAttribute("data-total-side")), ["OVER", "UNDER"]);
    expect(name + ": each block is a labelled group", blocks.map((b) => [b.getAttribute("role"), b.getAttribute("aria-label")]), [["group", "Over"], ["group", "Under"]]);
    expect(
      name + ": each block's header reads tag, name, count",
      blocks.map((b) => Array.from(b.firstElementChild?.children ?? []).map((c) => (c.textContent ?? "").trim())),
      [["O", "Over", "— 2 picks"], ["U", "Under", "— 3 picks"]]
    );
    expect(name + ": a rule separates the blocks, stacked (no side-by-side layout)", [column.className.includes("divide-y"), /\b(grid|flex)\b/.test(column.className)], [true, false]);
    const names = (el: Element) => Array.from(el.querySelectorAll("a")).map((a) => a.textContent);
    expect(name + ": Over block holds the Over picks only", names(blocks[0]), ["Capper o1", "Capper o2"]);
    expect(name + ": Under block holds the Under picks only", names(blocks[1]), ["Capper u1", "Capper u3", "Capper u2"]);
    expect(name + ": every pick on the game renders exactly once", names(container).sort(), PICKS.map((p) => "Capper " + p.pickId).sort());
    expect(name + ": no Over/Under block outside the Totals column", container.querySelectorAll("[data-total-side]").length, 2);
  }

  console.log("\n########## 2. Feed Live / game page: GamePicksExpander ##########");
  {
    const { container, root } = await mount(h(GamePicksExpander, { picks: PICKS }));
    expect("closed: no picks listed yet", container.querySelectorAll("[data-totals-column]").length, 0);
    await click(container.querySelector("button"));
    await checkTotalsColumn("Feed", container);
    await React.act(async () => root.unmount());
    container.remove();
  }

  console.log("\n########## 3. Grid Live: GameDetailPanel ##########");
  {
    const data = buildGridLiveGamePanelData({ homeTeam: "Chicago Cubs", awayTeam: "Pittsburgh Pirates" }, "baseball_mlb", "MLB", PICKS);
    const { container, root } = await mount(h(GameDetailPanel, { data, commenceTime: FUTURE, pickCount: PICKS.length }));
    await checkTotalsColumn("Grid", container);
    await React.act(async () => root.unmount());
    container.remove();
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
