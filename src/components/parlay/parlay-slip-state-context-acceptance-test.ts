// The slip state model inside the real ParlayPoolProvider (jsdom): an old
// stored slip hydrates into the new fields and is re-saved as v2; Live's
// direct-write picks and targets; a pick's game can't be untargeted; Send to
// generator turns slip mode off (confirming old-style ticks first); Send to
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
  Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, started: false }]));
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

  // ---- 3. Send to generator: slip mode off, old-style ticks confirmed ----
  await mount("u2");
  await act(() => ctx.enterAddMode());
  await act(() => ctx.toggleChecked(pick("t1", "g7")));
  check("setup: slip mode on with one tick", ctx.slipMode && ctx.checkedPicks.size === 1);
  await act(() => ctx.sendToGenerator());
  check("Send to generator: the tick is confirmed into the slip and slip mode is off", !ctx.slipMode && ctx.pool.some((p) => p.pickId === "t1") && ctx.checkedPicks.size === 0);
  await mount("u2");
  check("...and slip mode is still off after a reload", !ctx.slipMode && stored("u2").legacy?.addMode === false);
  await act(() => ctx.enterAddMode());
  await act(() => ctx.sendToGenerator());
  check("Send to generator with nothing ticked just turns slip mode off", !ctx.slipMode);

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
    Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: id === "k" ? FUTURE : "2000-01-01T00:00:00.000Z", started: id !== "k" }]));
  await mount("u3");
  check("two picks pruned because their games started: the line says so", ctx.removedLine === "2 picks removed — games started", String(ctx.removedLine));
  
  await act(() => root!.unmount());
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
