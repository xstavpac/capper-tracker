// The /parlay generator page (ParlayWorkspace: stat tiles + GeneratorCard +
// result) rendered on jsdom with the real slip provider and the real engine.
// Only the server calls are replaced: generateParlayAction (counted; it builds
// a fixed snapshot and runs the real engine on it), getLeagueRecordsAction, the
// slip's revalidation, and fetch for /api/parlay/fanduel-link. Covers what the
// old Auto-Generate / My Picks UI tests covered, on the new page:
// tiles, Your Picks (×, the note, links), targets (chips, your-picks chip, Use
// full slate), filters (locked leagues, max per game 1-5, Fill from), the
// 25-leg cap, Generate (one request), Regenerate and settings changes (no
// request), a pool change clearing the result, SGP pricing, shortfall notes,
// no "Why this leg?", and Send to FanDuel on every tab clearing the slip.
// Pure - no DB. Run with:
//   npx tsx src/components/parlay/generator-card-acceptance-test.ts
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GenerateRequest } from "@/server/actions/parlay-generate";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const FUTURE = "2099-06-01T23:00:00.000Z";
const TEAMS: [string, string, string][] = [
  ["New York Yankees", "Boston Red Sox", "Yankees"],
  ["Toronto Blue Jays", "Tampa Bay Rays", "Blue Jays"],
  ["Houston Astros", "Baltimore Orioles", "Astros"],
  ["Cleveland Guardians", "Detroit Tigers", "Guardians"],
];
const categoryRecords: GeneratorSnapshot["categoryRecords"] = {};
function mk(id: string, g: number, kind: "ML" | "OVER" | "AWAY", wins: number): GeneratorPick {
  const [home, away, nick] = TEAMS[g];
  const category = kind === "ML" ? "FAV_ML" : kind === "AWAY" ? "DOG_ML" : "OVER";
  categoryRecords["cap-" + id + "|" + category] = { key: category, label: category, wins, losses: 40 - wins, pushes: 0, winPct: (wins / 40) * 100, count: 40 };
  const detail = kind === "ML" ? nick + " ML" : kind === "AWAY" ? away.split(" ").pop() + " ML" : "Over 8.5";
  return {
    pickId: id, capperId: "cap-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category, leagueName: "MLB",
    gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: detail, odds: -110, units: 1, status: "PENDING",
    betType: kind === "OVER" ? "TOTAL" : "MONEYLINE", period: "FULL_GAME", rawBetDetail: detail, line: kind === "OVER" ? 8.5 : null,
    homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}
const PICKS = TEAMS.flatMap((_, g) => [mk(`g${g}ml`, g, "ML", 28 - g), mk(`g${g}o`, g, "OVER", 26 - g), mk(`g${g}a`, g, "AWAY", 15)]);
const games: GeneratorGame[] = TEAMS.map(([home, away], g) => ({ gameId: "G" + g, gameLabel: away + " @ " + home, gameTime: FUTURE, leagueName: "MLB", picks: PICKS.filter((p) => p.gameId === "G" + g) }));

const requests: GenerateRequest[] = [];
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-generate", {
  generateParlayAction: async (req: GenerateRequest) => {
    requests.push(req);
    const { buildGeneratedParlay } = await import("@/lib/parlay/generator");
    const snapshot: GeneratorSnapshot = {
      builtAt: new Date().toISOString(),
      games: req.targets.length > 0 ? games.filter((g) => req.targets.some((t) => t.gameId === g.gameId) || req.slipPickIds.some((id) => id.startsWith(g.gameId.toLowerCase()))) : games,
      slipPicks: req.slipPickIds.map((id) => PICKS.find((p) => p.pickId === id)!),
      targets: req.targets.map((t) => t.gameId),
      leagueRecords: { records: {}, streaks: {}, last20: {} },
      categoryRecords,
    };
    return { snapshot, parlay: buildGeneratedParlay(snapshot, req.settings, null, new Date()) };
  },
});
stub("../../server/actions/picks", { getLeagueRecordsAction: async () => ({ records: {}, streaks: {}, last20: {} }) });
stub("../../server/actions/parlay-slip", {
  getSlipPickStatesAction: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, started: false }])),
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
  // Send to FanDuel's route: every leg found, one betslip link.
  g.fetch = async (_url: string, init: { body: string }) => {
    const { pickIds } = JSON.parse(init.body) as { pickIds: string[] };
    return { ok: true, json: async () => ({ legs: pickIds.map((pickId) => ({ pickId, status: "matched", fanDuelOdds: -110, pickOdds: -110, sentLine: null })), url: "https://fanduel.example/betslip" }) };
  };
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
  const button = (label: string) => buttons().find((b) => (b.textContent ?? "").trim() === label || b.getAttribute("aria-label") === label);
  const click = async (b: Element | undefined) => {
    if (!b) throw new Error("no such control");
    await act(() => void (b as HTMLElement).click());
    await settle();
  };

  // A stored slip: two picks on G0 and G1, one target (G3).
  const slip = (picks: ExpanderPick[], targets: { gameId: string; gameLabel: string; gameTime: string; leagueName: string }[]) =>
    win.localStorage.setItem("parlay-pool:u1", JSON.stringify({ version: 2, picks, targets, excludedLeagues: [], legacy: { addMode: false, legCount: 3, checkedPicks: [] } }));
  slip([PICKS[0], PICKS[3]], [{ gameId: "G3", gameLabel: games[3].gameLabel, gameTime: FUTURE, leagueName: "MLB" }]);

  const root: Root = createRoot(el);
  await act(() => root.render(h(AppRouterContext.Provider, { value: router as never }, h(ParlayPoolProvider, { userId: "u1", children: null }, h(Probe), h(ParlayWorkspace, { leagues: ["NFL", "MLB"] })))));
  await settle();

  // ---- Tiles and sections ----
  check("tile: Your picks 2, always in the parlay", /Your picks2always in the parlay/.test(text()), text().slice(0, 160));
  check("tile: Targeting 3 games (the target + the two picks' games)", text().includes("3 games"));
  check("tile: Legs N of 25 max", /3 of 25 max/.test(text()));
  check("Your picks: both picks, grouped by game, each with ×", ["Remove Capper g0ml pick from your slip", "Remove Capper g1ml pick from your slip"].every((l) => button(l)));
  check("Your picks: the note and the Live link", text().includes("Every pick here goes in the parlay. Remove one with ×.") && text().includes("+ Add picks from Live"));
  check("Targets: the explicit target has ×, the picks' games say · your picks", Boolean(button("Stop targeting " + games[3].gameLabel)) && (text().match(/· your picks/g) ?? []).length === 2);
  check("Targets: Use full slate shown", Boolean(button("Use full slate")));
  check("no 'Why this leg?' anywhere", !text().includes("Why this leg"));
  check("no old 'N legs were removed' banner", !/legs? (was|were) removed from your Parlay slip/.test(text()));

  // ---- Filters ----
  check("MLB has picks: its pill can't be switched off", el.querySelector('[aria-label="MLB is on: your slip has picks or games from it"]') !== null);
  await click(el.querySelector('[aria-label="MLB is on: your slip has picks or games from it"]') ?? undefined);
  check("...clicking it changes nothing", ctx.isLeagueInScope("MLB"));
  const more = () => button("More: Max legs per game") as HTMLButtonElement;
  for (let i = 0; i < 6; i++) await click(more());
  const shown = () => more().parentElement?.querySelector('[aria-live="polite"]')?.textContent;
  check("Max legs per game: a −/+ stepper that stops at 5", more().disabled && shown() === "5", `shown=${shown()} disabled=${more().disabled}`);
  for (let i = 0; i < 4; i++) await click(button("Fewer: Max legs per game"));

  // ---- Generate: one request ----
  await click(button("Generate parlay"));
  check("Generate: one request, with the slip's ids, the explicit target only, the in-scope leagues", requests.length === 1 && requests[0].slipPickIds.join() === "g0ml,g1ml" && requests[0].targets.map((t) => t.gameId).join() === "G3" && requests[0].leagues.join() === "NFL,MLB", JSON.stringify(requests[0]));
  check("result: 'Your parlay · 3 legs'", text().includes("Your parlay · 3 legs"), text().slice(-400));
  check("result: the two slip picks marked 'Your pick'", (text().match(/Your pick(?!s)/g) ?? []).length >= 2);
  check("result: every leg shows its W-L", /\(\d+–\d+\)/.test(text()));
  check("result: Primary / Hedge / Contrarian tabs", ["Primary", "Hedge", "Contrarian"].every((t) => el.querySelector(`[role="tab"]`) && Array.from(el.querySelectorAll('[role="tab"]')).some((b) => (b.textContent ?? "").startsWith(t))));
  check("result: Send to FanDuel on the Primary", Boolean(button("Send to FanDuel")));

  // ---- Regenerate, settings: no request ----
  await click(button("Regenerate"));
  check("Regenerate: no request", requests.length === 1, `requests=${requests.length}`);
  await click(button("More: Max legs per game"));
  check("a settings change rebuilds without a request", requests.length === 1 && text().includes("Your parlay"));
  await click(button("Fewer: Max legs per game"));

  // ---- Tabs: Send to FanDuel on every one ----
  for (const tab of ["Hedge", "Contrarian"]) {
    await click(Array.from(el.querySelectorAll('[role="tab"]')).find((b) => (b.textContent ?? "").startsWith(tab)));
    check(`${tab}: Send to FanDuel is there`, Boolean(button("Send to FanDuel")));
    check(`${tab}: the slip picks are unchanged`, (text().match(/your pick - never swapped/g) ?? []).length === 2);
  }

  // ---- A pool change clears the result ----
  await click(button("Use full slate"));
  check("Use full slate: back to the full slate text, result cleared", text().includes("Choose which games to build around, or use the full slate.") && !text().includes("Your parlay ·"));

  // ---- Same-game legs: no combined odds; shortfall said ----
  await click(button("Generate parlay"));
  check("full slate Generate: a second request", requests.length === 2 && requests[1].targets.length === 0);
  await click(button("More: Max legs per game"));
  for (let i = 0; i < 5; i++) await click(button("More legs"));
  check("8 legs over 4 games at max 2: same-game legs tagged SGP, combined odds left to FanDuel", text().includes("SGP") && text().includes("Priced at FanDuel"), text().slice(-600));
  for (let i = 0; i < 3; i++) await click(button("More legs"));
  check("at what the pool holds: the stepper stops and says why", ctx.legCount === 8 && text().includes("8 max from 4 games with qualified picks"), `legs=${ctx.legCount}`);

  // ---- Send to FanDuel clears the slip ----
  await click(button("Send to FanDuel"));
  const open = Array.from(el.querySelectorAll("a")).find((a) => (a.textContent ?? "") === "Open FanDuel");
  check("Send to FanDuel: the betslip link is offered", Boolean(open));
  await act(() => {
    open!.addEventListener("click", (e) => e.preventDefault());
    open!.click();
  });
  await settle();
  check("opening FanDuel keeps the slip, its targets and the result; slip mode ends", ctx.pool.length > 0 && !ctx.slipMode && text().includes("Your parlay ·"), `pool=${ctx.pool.length}`);
  await click(button("Clear all picks"));
  check("Clear all picks empties the slip and offers Undo", ctx.pool.length === 0 && Boolean(button("Undo")));
  await click(button("Undo"));
  check("Undo brings the picks back", ctx.pool.length > 0);
  await click(button("Clear all picks"));
  await act(() => ctx.clearTargets());
  check("Fill from: with no picks, Best available is the only choice", text().includes("Add picks to build from your picks only"));

  // ---- The 25-leg cap ----
  for (let i = 0; i < 30; i++) {
    const b = button("More legs") as HTMLButtonElement;
    if (!b || b.disabled) break;
    await click(b);
  }
  check("the leg stepper reaches 25 and answers a 26th with '25 legs max'", ctx.legCount === 25 && text().includes("25 legs max"), `legs=${ctx.legCount}`);

  await act(() => root.unmount());
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
