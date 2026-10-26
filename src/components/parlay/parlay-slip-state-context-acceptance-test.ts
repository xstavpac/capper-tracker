// The slip state model inside the real ParlayPoolProvider (jsdom): an old
// stored slip hydrates into the new fields and is re-saved as v2; Live's
// direct-write picks and targets; a pick's game can't be untargeted; slip mode
// lives in memory only (never stored), Send to generator and Exit turn it off; Send to
// FanDuel's clear; the quiet "games started" line Your Picks shows. Only the
// slip's revalidation action is replaced. Pure - no DB. Run with:
//   npx tsx src/components/parlay/parlay-slip-state-context-acceptance-test.ts
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
let respond: (ids: string[]) => Promise<States> = async (ids) =>
  Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, over: false, gameStatus: null }]));
const actionPath = require.resolve("../../server/actions/parlay-slip");
require.cache[actionPath] = {
  id: actionPath,
  filename: actionPath,
  loaded: true,
  exports: { getSlipPickStatesAction: (ids: string[]) => respond(ids) },
} as unknown as NodeJS.Module;

function pick(pickId: string, gameId: string, leagueName = "NFL"): ExpanderPick {
  return {
    pickId, capperId: "capper-" + pickId, capperName: "Capper " + pickId, capperColorTag: null, capperIsFavorite: false,
    category: null, leagueName, gameId, gameLabel: "Away @ Home " + gameId, betDetail: "Home ML",
    odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: "Home ML", line: null,
    homeTeam: "Home", awayTeam: "Away", gameTime: FUTURE, teamGroup: "HOME", teamLabel: "Home", teamColor: null,
    datePosted: "2098-12-31T00:00:00.000Z",
  };
}
const game = (gameId: string, leagueName = "NFL") => ({ gameId, gameLabel: "Away @ Home " + gameId, gameTime: FUTURE, leagueName });

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/live" });
  const win = dom.window;
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.self = win;
  g.document = win.document;
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { ParlayPoolProvider, useParlayPool } = await import("./parlay-pool-context");
  const h = React.createElement;
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());
  const tick = () => new Promise((r) => setTimeout(r, 0));

  let ctx!: ReturnType<typeof useParlayPool>;
  function Probe() {
    ctx = useParlayPool();
    return null;
  }
  let root: Root | null = null;
  async function mount(userId: string) {
    if (root) await act(() => root!.unmount());
    const el = win.document.createElement("div");
    win.document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(h(ParlayPoolProvider, { key: userId, userId, children: null }, h(Probe)));
      await tick();
    });
    await act(async () => {
      await tick();
    });
  }
  const stored = (userId: string) => JSON.parse(win.localStorage.getItem("parlay-pool:" + userId) ?? "{}");

  // ---- 1. An old (v1) slip hydrates, and is saved back as v2 ----
  win.localStorage.setItem(
    "parlay-pool:u1",
    JSON.stringify({ pool: [pick("a", "g1")], games: [game("g2")], excludedLeagues: ["MLB"], legCount: 3, locked: ["a"], source: "SLIP_ONLY" })
  );
  await mount("u1");
  check("v1 slip: its pick is in the slip", ctx.pool.map((p) => p.pickId).join() === "a", ctx.pool.map((p) => p.pickId).join());
  check("v1 slip: its game item is a target", ctx.targets.map((t) => t.gameId).join() === "g2");
  check("v1 slip: its MLB exclusion is kept, its leg count read", !ctx.isLeagueInScope("MLB") && ctx.legCount === 3);
  const s1 = stored("u1");
  check("re-saved as v2 with picks/targets and the legacy block (no locks)", s1.version === 2 && s1.picks?.[0]?.pickId === "a" && s1.targets?.[0]?.gameId === "g2" && s1.legacy?.legCount === 3 && s1.legacy?.locked === undefined, JSON.stringify(s1).slice(0, 200));
  check("targeted games: the target, then the pick's game", ctx.targetedGames.map((t) => `${t.gameId}:${t.explicit ? "E" : ""}${t.viaPicks ? "P" : ""}`).join() === "g2:E,g1:P", JSON.stringify(ctx.targetedGames.map((t) => t.gameId)));
  check("the generator is told the explicit target only", JSON.stringify(ctx.generatorTargets()) === JSON.stringify([{ gameId: "g2", leagueName: "NFL" }]));

  // ---- 2. Direct-write picks and targets ----
  await act(() => ctx.togglePick(pick("b", "g3", "MLB")));
  check("a pick goes straight in (no Confirm) and switches its league on", ctx.pool.some((p) => p.pickId === "b") && ctx.isLeagueInScope("MLB"));
  await act(() => ctx.togglePick(pick("b", "g3", "MLB")));
  check("and comes straight out", !ctx.pool.some((p) => p.pickId === "b"));
  let refused = true;
  await act(() => {
    refused = !ctx.toggleTarget(game("g1"));
  });
  check("a pick's game can't be untargeted", refused && ctx.isTargetedViaPicks("g1") && ctx.isTargeted("g1"));
  await act(() => {
    ctx.toggleTarget(game("g4", "NBA"));
  });
  check("targeting a game adds it", ctx.isTargeted("g4") && ctx.targets.some((t) => t.gameId === "g4"));
  await act(() => {
    ctx.toggleTarget(game("g4", "NBA"));
  });
  check("and untargeting removes it", !ctx.isTargeted("g4"));
  await act(() => {
    for (let i = 0; i < 30; i++) ctx.togglePick(pick("cap" + i, "gc" + i));
  });
  check("picks stop at the leg cap and say so", ctx.pool.length === 25 && ctx.overCapBy === 1, `pool=${ctx.pool.length} over=${ctx.overCapBy}`);

  // ---- 3. Slip mode: in memory only; Send to generator and Exit turn it off ----
  await mount("u2");
  await act(() => ctx.enterSlipMode());
  await act(() => ctx.togglePick(pick("t1", "g7")));
  check("setup: slip mode on, the checked pick already in the slip", ctx.slipMode && ctx.pool.some((p) => p.pickId === "t1"));
  check("slip mode is never stored", stored("u2").legacy?.addMode === undefined && stored("u2").slipMode === undefined, JSON.stringify(stored("u2").legacy));
  await mount("u2");
  check("a reload: the slip is back, slip mode is not", !ctx.slipMode && ctx.pool.some((p) => p.pickId === "t1"));
  await act(() => ctx.enterSlipMode());
  await act(() => ctx.sendToGenerator());
  check("Send to generator turns slip mode off, the slip kept", !ctx.slipMode && ctx.pool.length === 1);
  await act(() => ctx.enterSlipMode());
  await act(() => ctx.exitSlipMode());
  check("Exit turns slip mode off too", !ctx.slipMode);

  // ---- 4. Send to FanDuel's clear ----
  await act(() => {
    ctx.toggleTarget(game("g8"));
  });
  await act(() => ctx.clearSlip());
  check("clearSlip: no picks, no targets, slip mode off", ctx.pool.length === 0 && ctx.targets.length === 0 && !ctx.slipMode);
  check("...saved that way", (stored("u2").picks ?? []).length === 0 && (stored("u2").targets ?? []).length === 0);

  // ---- 5. The quiet "games started" line ----
  win.localStorage.setItem("parlay-pool:u3", JSON.stringify({ version: 2, picks: [pick("s1", "gs1"), pick("s2", "gs2"), pick("k", "gk")], targets: [] }));
  respond = async (ids) =>
    Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: id === "k" ? FUTURE : "2000-01-01T00:00:00.000Z", over: id !== "k", gameStatus: null }]));
  await mount("u3");
  check("two picks pruned because their games started: the notice names them", ctx.removed?.picks.map((p) => p.pickId + ":" + p.result).join() === "s1:Over,s2:Over", JSON.stringify(ctx.removed));
  await act(() => ctx.dismissRemoved());
  check("Dismiss clears the notice", ctx.removed === null);

  // ---- 6. A deleted pick is named too, not dropped silently ----
  win.localStorage.setItem("parlay-pool:u4", JSON.stringify({ version: 2, picks: [pick("gone", "gg1"), pick("here", "gg2")], targets: [] }));
  respond = async (ids) => Object.fromEntries(ids.filter((id) => id !== "gone").map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, over: false, gameStatus: null }]));
  await mount("u4");
  check("a pick the DB no longer has is pruned and named", ctx.pool.map((p) => p.pickId).join() === "here" && ctx.removed?.picks[0]?.result === "Removed" && ctx.removed.picks[0].pickId === "gone", JSON.stringify(ctx.removed));

  // ---- 7. Clear all picks, and Undo ----
  respond = async (ids) => Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, over: false, gameStatus: null }]));
  await mount("u5");
  await act(() => ctx.togglePick(pick("c1", "gc1")));
  await act(() => ctx.togglePick(pick("c2", "gc2")));
  await act(() => ctx.clearSlip());
  check("Clear all: slip empty, undo offers the 2 picks", ctx.pool.length === 0 && ctx.clearedCount === 2);
  await act(() => ctx.togglePick(pick("c3", "gc3")));
  await act(() => ctx.undoClear());
  check("Undo: the cleared picks are back, one added since is kept, no doubles", ctx.pool.map((p) => p.pickId).sort().join() === "c1,c2,c3" && ctx.clearedCount === 0, ctx.pool.map((p) => p.pickId).join());

  // ---- 8. Another tab's change is taken, and not written back over ----
  const key5 = "parlay-pool:u5";
  const other = { version: 2, picks: [pick("o1", "go1"), pick("c1", "gc1")], targets: [], excludedLeagues: [], legacy: { legCount: 4 } };
  win.localStorage.setItem(key5, JSON.stringify(other));
  await act(async () => {
    win.dispatchEvent(new win.StorageEvent("storage", { key: key5, newValue: JSON.stringify(other), storageArea: win.localStorage }));
    await tick();
  });
  check("storage event: this tab shows the other tab's slip", ctx.pool.map((p) => p.pickId).join() === "o1,c1" && ctx.legCount === 4, ctx.pool.map((p) => p.pickId).join());
  await act(() => ctx.setLegCount(5));
  check("...and its next save carries that slip, not the older one", stored("u5").picks.map((p: { pickId: string }) => p.pickId).join() === "o1,c1", JSON.stringify(stored("u5").picks?.map((p: { pickId: string }) => p.pickId)));
  await act(async () => {
    win.dispatchEvent(new win.StorageEvent("storage", { key: key5, newValue: null, storageArea: win.localStorage }));
    await tick();
  });
  check("the other tab signing out (key removed) empties this slip", ctx.pool.length === 0);

  // ---- 9. refreshSlip re-checks now ----
  win.localStorage.setItem("parlay-pool:u6", JSON.stringify({ version: 2, picks: [pick("r1", "gr1")], targets: [] }));
  await mount("u6");
  respond = async (ids) => Object.fromEntries(ids.map((id) => [id, { status: "LOSS", odds: -110, kickoff: FUTURE, over: false, gameStatus: null }]));
  let changed = false;
  await act(async () => {
    changed = await ctx.refreshSlip();
  });
  check("refreshSlip: sees a pick graded since, prunes and names it", changed && ctx.pool.length === 0 && ctx.removed?.picks[0]?.result === "Lost", JSON.stringify(ctx.removed));
  
  await act(() => root!.unmount());
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
