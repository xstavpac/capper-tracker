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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
// The real engine, loaded once in main() before anything renders. The stubbed action calls it
// synchronously: a dynamic import inside the action was a real module load on every Generate,
// slower than the fixed settle() below on a loaded CI runner (Generating… still on screen).
let buildGenerated: typeof import("@/lib/parlay/generator").buildGeneratedParlay | null = null;
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-generate", {
  generateParlayAction: async (req: GenerateRequest) => {
    requests.push(req);
    if (!buildGenerated) throw new Error("generator not preloaded");
    const snapshot: GeneratorSnapshot = {
      builtAt: new Date().toISOString(),
      games: req.targets.length > 0 ? games.filter((g) => req.targets.some((t) => t.gameId === g.gameId) || req.slipPickIds.some((id) => id.startsWith(g.gameId.toLowerCase()))) : games,
      slipPicks: req.slipPickIds.map((id) => PICKS.find((p) => p.pickId === id)!),
      targets: req.targets.map((t) => t.gameId),
      leagueRecords: { records: {}, streaks: {}, last20: {} },
      categoryRecords,
    };
    return { snapshot, parlay: buildGenerated(snapshot, req.settings, null, new Date()) };
  },
});
// Consensus Hybrid's actions: counted, never reached by Standard.
const hybridRequests: unknown[] = [];
// What the Hybrid action answers; a test swaps it to show a result.
const NO_BOX = { result: { primary: null, alternates: [], note: null, delivery: { requestedLegs: 3, deliveredLegs: 0, boxes: 0, qualifyingGames: 0, shortOfGames: true } }, notes: [], candidateEvents: [], eventSportKeys: {}, linkable: true, generatedAt: new Date().toISOString() };
let hybridAnswer: unknown = NO_BOX;
stub("../../server/actions/parlay-hybrid", {
  hybridGenerateAction: async (req: unknown) => {
    hybridRequests.push(req);
    return hybridAnswer;
  },
  hybridFanDuelLinkAction: async () => ({ error: "not used here" }),
});
stub("../../server/actions/picks", { getLeagueRecordsAction: async () => ({ records: {}, streaks: {}, last20: {} }) });
stub("../../server/actions/parlay-slip", {
  getSlipPickStatesAction: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, over: false, gameStatus: null }])),
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
  buildGenerated = (await import("@/lib/parlay/generator")).buildGeneratedParlay;
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
  // Bounded wait on the DOM itself: throws on timeout, never retries silently.
  const waitUntil = async (cond: () => boolean, what: string, timeoutMs = 10_000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out after " + timeoutMs + "ms waiting for " + what);
      await act(async () => void (await tick()));
    }
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
  const generate = async () => {
    await click(button("Generate parlay"));
    await waitUntil(() => !text().includes("Generating…"), "Generating… to clear");
  };
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

  // ---- "+ Add ... from Live": the link opens Live with slip mode already on ----
  const liveLink = (label: string) => Array.from(el.querySelectorAll("a")).find((a) => (a.textContent ?? "").trim() === label);
  const slipNow = () => JSON.stringify({ pool: ctx.pool.map((p) => p.pickId), targets: ctx.targets.map((t) => t.gameId), legCount: ctx.legCount });
  const slipBefore = slipNow();
  for (const label of ["+ Add picks from Live", "+ Add games from Live"]) {
    check(`${label}: slip mode is off before the click`, !ctx.slipMode);
    check(`${label}: still a link to /live`, liveLink(label)?.getAttribute("href") === "/live");
    await act(() => void (liveLink(label) as HTMLElement).click());
    await settle();
    check(`${label}: lands in slip mode`, ctx.slipMode);
    check(`${label}: the slip, its targets and the leg count are unchanged`, slipNow() === slipBefore, slipNow());
    await act(() => ctx.exitSlipMode());
  }
  const cardSource = readFileSync(join(__dirname, "generator-card.tsx"), "utf8");
  const liveLinks = cardSource.match(/<Link href="\/live"[^>]*>/g) ?? [];
  check("source: both Live links (picks, games) carry onClick={slip.enterSlipMode}", liveLinks.length === 2 && liveLinks.every((l) => l.includes("onClick={slip.enterSlipMode}")), JSON.stringify(liveLinks));

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
  await generate();
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

  // ---- Tabs: Send to FanDuel on every one; Swap: on Hedge and Contrarian only ----
  const tabButton = (tab: string) => Array.from(el.querySelectorAll('[role="tab"]')).find((b) => (b.textContent ?? "").startsWith(tab));
  const swapGroup = () => el.querySelector('[role="radiogroup"][aria-label="Swap"]');
  const swapChoice = (label: string) => Array.from(swapGroup()?.querySelectorAll('[role="radio"]') ?? []).find((b) => (b.textContent ?? "").trim() === label);
  const legList = () => el.querySelector("ol")?.textContent ?? "";
  const primaryBefore = legList();
  check("Primary: no Swap control", swapGroup() === null && !text().includes("Swap:"));
  for (const tab of ["Hedge", "Contrarian"]) {
    await click(tabButton(tab));
    check(`${tab}: Send to FanDuel is there`, Boolean(button("Send to FanDuel")));
    check(
      `${tab}: Swap: Suggested · Your picks · All, All by default`,
      text().includes("Swap:") && ["Suggested", "Your picks", "All"].every((l) => swapChoice(l)) && swapChoice("All")?.getAttribute("aria-checked") === "true"
    );
    await click(swapChoice("Suggested"));
    check(`${tab} · Suggested: the slip picks are unchanged`, (text().match(/your pick - Swap is set to Suggested/g) ?? []).length === 2);
    await click(swapChoice("Your picks"));
    check(`${tab} · Your picks: the generated leg is unchanged, the slip picks are not`, (text().match(/suggested leg - Swap is set to Your picks/g) ?? []).length === 1 && !text().includes("Swap is set to Suggested"));
    check(`${tab} · Your picks: remembered for this user`, win.localStorage.getItem("parlay-swap-scope:u1") === "YOUR_PICKS");
    await click(swapChoice("All"));
    check(`${tab} · All: no leg is out of scope; the default is not stored`, !text().includes("Swap is set to") && win.localStorage.getItem("parlay-swap-scope:u1") === null);
  }
  check("Swap changes: no request", requests.length === 1, `requests=${requests.length}`);
  await click(tabButton("Hedge"));
  check("Hedge · All: a swapped slip pick says it replaced your pick", text().includes("Replaces your pick"), legList());
  await click(tabButton("Primary"));
  check("Primary: the same legs after every Swap change", legList() === primaryBefore);

  // ---- A pool change clears the result ----
  await click(button("Use full slate"));
  check("Use full slate: back to the full slate text, result cleared", text().includes("Choose which games to build around, or use the full slate.") && !text().includes("Your parlay ·"));

  // The no-targets branch has its own "+ Add games from Live" link.
  await act(() => void (liveLink("+ Add games from Live") as HTMLElement).click());
  await settle();
  check("+ Add games from Live (no targets yet): lands in slip mode too", ctx.slipMode && ctx.targets.length === 0);
  await act(() => ctx.exitSlipMode());

  // ---- Same-game legs: no combined odds; shortfall said ----
  await generate();
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

  // ---- Standard | Hybrid ----
  await click(button("Standard"));
  check("Standard is the default view: its own controls, no Hybrid line", text().includes("Max legs per game") && !text().includes("Hybrid builds from capper consensus"));
  const standardRequests = requests.length;
  {
    const t = text();
    const row = el.querySelector('section[aria-label="Pick Filters"]');
    const footerButtons = Array.from(el.querySelectorAll(":scope button")).filter((b) => ["Clear result", "Generate parlay"].includes((b.textContent ?? "").trim()));
    check("Standard: Total legs is the first row of the Pick Filters settings block, before Max legs per game", Boolean(row) && (row!.textContent ?? "").indexOf("Total legs") > 0 && (row!.textContent ?? "").indexOf("Total legs") < (row!.textContent ?? "").indexOf("Max legs per game"));
    check("Standard: the leg stepper lives in Pick Filters, not beside Clear / Generate", Boolean(button("More legs")) && row!.contains(button("More legs") as Node) && footerButtons.length === 2 && !footerButtons[0].parentElement!.parentElement!.textContent!.includes("from your cappers"), t.slice(0, 80));
  }
  await click(button("Hybrid"));
  check("Hybrid: the muted slip line, its controls", text().includes("Hybrid builds from capper consensus. Your slip isn't used in this mode.") && text().includes("Target odds") && text().includes("Line range") && text().includes("Legs per game") && text().includes("Total legs") && !text().includes("Max legs"));
  check("Hybrid: leg count, max legs per game, Pick Mix, fill toggle and Props are gone", !text().includes("Max legs per game") && !text().includes("Fill from") && !text().includes("Customize Mix") && !text().includes("Props") && !text().includes("Your picks ·"));
  check("Hybrid: switching modes sends no request", requests.length === standardRequests && hybridRequests.length === 0);
  await click(button("Generate parlay"));
  check("Hybrid: the Generate button sends exactly one hybrid request, none to Standard", hybridRequests.length === 1 && requests.length === standardRequests);
  const sent = hybridRequests[0] as { settings: { targetMin: number; targetMax: number; maxLegs: number; width: string; minWinPct: number; boxLegs: string } };
  check(
    "Hybrid: defaults are -140 / -110, Legs Auto with 3 max legs, balanced, 55%",
    sent.settings.targetMin === -140 && sent.settings.targetMax === -110 && sent.settings.boxLegs === "auto" && sent.settings.maxLegs === 3 && sent.settings.width === "balanced" && sent.settings.minWinPct === 55
  );
  // Total Legs reaches the server as #351 intended: boxLegs says 2 / 3 / auto, so 3 and Auto stay apart.
  const payloadFor = async (label: string) => {
    await click(button(label));
    await click(button("Generate parlay"));
    const req = hybridRequests[hybridRequests.length - 1] as { settings: Record<string, unknown> };
    console.log(`  payload · ${label}: ${JSON.stringify(req)}`);
    return req.settings;
  };
  const p2 = await payloadFor("2 Legs");
  const p3 = await payloadFor("3 Legs");
  const pAuto = await payloadFor("Auto");
  check("Legs per game 2 Legs sends boxLegs \"2\"; Total legs stays at its default 3", p2.boxLegs === "2" && p2.maxLegs === 3, JSON.stringify(p2));
  check("Legs per game 3 Legs sends boxLegs \"3\", maxLegs 3", p3.boxLegs === "3" && p3.maxLegs === 3, JSON.stringify(p3));
  check("Legs per game Auto sends boxLegs \"auto\", maxLegs 3", pAuto.boxLegs === "auto" && pAuto.maxLegs === 3, JSON.stringify(pAuto));
  check("3 Legs and Auto are distinguishable on the server (boxLegs differs)", p3.boxLegs !== pAuto.boxLegs);
  check("the three requests differ only in boxLegs / maxLegs", [p2, p3, pAuto].every((q) => JSON.stringify({ ...q, boxLegs: 0, maxLegs: 0 }) === JSON.stringify({ ...p2, boxLegs: 0, maxLegs: 0 })));
  check("Hybrid: no-box result is explained in plain words", text().includes("No game has qualifying consensus on both a side and a total."));

  // ---- Total legs: a 2-25 stepper under Legs per game ----
  const totalMore = () => button("More: Total legs") as HTMLButtonElement;
  const totalFewer = () => button("Fewer: Total legs") as HTMLButtonElement;
  const totalShown = () => totalMore().parentElement?.querySelector('[aria-live="polite"]')?.textContent;
  const labels = () => Array.from(el.querySelectorAll("span")).map((s) => (s.textContent ?? "").trim());
  const rowOrder = () => text().indexOf("Legs per game") < text().indexOf("Total legs");
  check("Total legs: a stepper below Legs per game, starting at 3", rowOrder() && totalShown() === "3", String(totalShown()));
  check("Total legs: both rows sit in the same tinted block as Standard's", Boolean(totalMore().closest("div.bg-\\[\\#F6F8FF\\]")) && Boolean(button("Auto")?.closest("div.bg-\\[\\#F6F8FF\\]")));
  check("Total legs: the helper says cap, whole games, one box per game", text().includes("A cap, not a target: the parlay is built from whole games' boxes, one per game."));
  check("Target odds at 3 total legs is plain 'Target odds'", labels().includes("Target odds") && !text().includes("Target odds (per game)"));
  await click(totalMore());
  check("Total legs 4: Target odds becomes '(per game)', with its note", totalShown() === "4" && labels().includes("Target odds (per game)") && text().includes("Each game's box is tuned to this range."), String(totalShown()));
  await click(totalFewer());
  check("...and back to plain at 3", totalShown() === "3" && !text().includes("Target odds (per game)"));
  for (let i = 0; i < 30; i++) if (!totalMore().disabled) await click(totalMore());
  check("Total legs stops at 25", totalMore().disabled && totalShown() === "25", String(totalShown()));
  await click(button("Generate parlay"));
  check("...and 25 is what the request carries", (hybridRequests[hybridRequests.length - 1] as { settings: { maxLegs: number } }).settings.maxLegs === 25);
  for (let i = 0; i < 30; i++) if (!totalFewer().disabled) await click(totalFewer());
  check("with Auto, Total legs goes down to 2", totalFewer().disabled && totalShown() === "2", String(totalShown()));
  await click(button("3 Legs"));
  check("choosing 3 Legs lifts Total legs from 2 to 3", totalShown() === "3", String(totalShown()));
  check("with 3 Legs, Total legs can't go below 3", totalFewer().disabled);
  await click(button("2 Legs"));
  await click(totalFewer());
  check("with 2 Legs, Total legs can go back to 2", totalShown() === "2");
  for (let i = 0; i < 1; i++) await click(totalMore());
  await click(button("Auto"));
  check("settings are back to Auto / 3", totalShown() === "3" && !text().includes("Target odds (per game)"));

  // ---- Results: a multi-box parlay, and a single box exactly as before ----
  const leg = (eventId: string, family: "SIDE" | "TOTAL", label: string, price: number, home: string, away: string) => ({
    positionKey: eventId + family, eventId, homeTeam: home, awayTeam: away, commenceTime: FUTURE, sport: "NFL", family, direction: family === "TOTAL" ? "OVER" : home, opposite: false,
    marketKey: family === "TOTAL" ? "alternate_totals" : "alternate_spreads", outcomeName: family === "TOTAL" ? "Over" : home, point: family === "TOTAL" ? 41.5 : 3.5, price, sid: null, link: null, label,
    tonightLine: null, edge: 0, edgeSource: "stored", keyNumberPush: null, snappedPoint: null, edgeReached: true, move: { rungs: 0, why: "" }, reason: label, isStale: false, marketLastUpdate: null,
    consensus: { supporters: 3, opposers: 0, score: 1, anchorLine: 0, anchorIsMoneyline: false, topSupporters: [] },
  });
  const box = (id: string, home: string, away: string, inTarget: boolean, american: number) => ({
    structure: "same-game-box", legs: [leg(id, "SIDE", home + " +3.5", -150, home, away), leg(id, "TOTAL", "Over 41.5", -130, home, away)], combinedAmerican: american, combinedDecimal: 1.8,
    impliedProbability: 0.55, isEstimate: true, inTarget, boxDescription: "Wins if " + home + " lose by 3 or fewer and 42+ total points", oddsAsOf: null, anyStale: false, consensusScore: 2, rungsMoved: 0,
  });
  const keys = { A: "americanfootball_nfl", B: "americanfootball_nfl", C: "americanfootball_nfl" };
  const boxes = [box("A", "Lions", "Bears", true, -120), box("B", "Packers", "Vikings", false, -300), box("C", "Jets", "Bills", true, -125)];
  hybridAnswer = {
    result: {
      primary: { structure: "multi-box", legs: boxes.flatMap((b) => b.legs), boxes, combinedAmerican: 265, combinedDecimal: 3.65, impliedProbability: 0.27, isEstimate: true, inTarget: false, boxDescription: "", oddsAsOf: null, anyStale: false, consensusScore: 6, rungsMoved: 0 },
      alternates: [],
      note: null,
      delivery: { requestedLegs: 15, deliveredLegs: 6, boxes: 3, qualifyingGames: 3, shortOfGames: true },
    },
    notes: [{ eventId: "X1", gameLabel: "Colts @ Titans", kind: "ladders-unavailable", message: "Live alternate prices are unavailable right now.", cause: "budget" }],
    candidateEvents: ["A", "B", "C"],
    eventSportKeys: keys,
    linkable: false,
    generatedAt: new Date().toISOString(),
  };
  await click(button("Generate parlay"));
  const gameSections = () => Array.from(el.querySelectorAll('section[aria-label^="Game "]'));
  check("multi-box: the header counts legs and games", text().includes("6 legs · 3 games"), text().slice(0, 200));
  check("multi-box: 'Delivered 6 of 15 legs · only 3 games qualified'", text().includes("Delivered 6 of 15 legs · only 3 games qualified"));
  check("multi-box: one section per game, each with its two legs and its own price", gameSections().length === 3 && gameSections().every((s) => s.querySelectorAll("ol > li").length === 2) && gameSections().map((s) => s.querySelector('[aria-label$="price"]')?.textContent).join() === "≈ -120,≈ -300,≈ -125", gameSections().map((s) => s.querySelector('[aria-label$="price"]')?.textContent).join());
  check("multi-box: only the out-of-band game is flagged", (text().match(/Closest match · outside your range/g) ?? []).length === 1 && gameSections()[1].textContent!.includes("Closest match · outside your range") && gameSections()[0].textContent!.includes("✓ In your target"));
  check("multi-box: the combined price is an estimate, and counts the games in target", text().includes("≈ +265") && text().includes("2 of 3 games in your target") && text().includes("FanDuel shows final price"));
  check("multi-box: the budget note from the server is shown", text().includes("price lookups are used up"));
  check("multi-box: no alternates tabs", !text().includes("Alt 1"));
  const send = button("Send to FanDuel") as HTMLButtonElement;
  check("multi-box over 4 legs: Send to FanDuel is disabled, with the reason", send.disabled && text().includes("Send to FanDuel isn't available yet for more than 4 legs."));

  // Four legs, linkable: still sendable.
  const two = boxes.filter((b) => b.inTarget);
  hybridAnswer = {
    result: { primary: { structure: "multi-box", legs: two.flatMap((b) => b.legs), boxes: two, combinedAmerican: 250, combinedDecimal: 3.5, impliedProbability: 0.28, isEstimate: true, inTarget: true, boxDescription: "", oddsAsOf: null, anyStale: false, consensusScore: 4, rungsMoved: 0 }, alternates: [], note: null, delivery: { requestedLegs: 4, deliveredLegs: 4, boxes: 2, qualifyingGames: 5, shortOfGames: false } },
    notes: [], candidateEvents: ["A", "C"], eventSportKeys: keys, linkable: true, generatedAt: new Date().toISOString(),
  };
  await click(button("Generate parlay"));
  check("4 legs: Send to FanDuel works", Boolean(button("Send to FanDuel")) && !(button("Send to FanDuel") as HTMLButtonElement).disabled && !text().includes("isn't available yet"));
  check("4 legs: 'Delivered 4 of 4 legs', no shortfall wording", text().includes("Delivered 4 of 4 legs") && !text().includes("only"));

  // A lone box at a big cap: honest about the one game.
  hybridAnswer = {
    result: { primary: boxes[0], alternates: [], note: null, delivery: { requestedLegs: 15, deliveredLegs: 2, boxes: 1, qualifyingGames: 1, shortOfGames: true } },
    notes: [], candidateEvents: ["A"], eventSportKeys: keys, linkable: true, generatedAt: new Date().toISOString(),
  };
  await click(button("Generate parlay"));
  check("one qualifying game at cap 15: 'Delivered 2 of 15 legs · only 1 game qualified'", text().includes("Delivered 2 of 15 legs · only 1 game qualified"));

  // The single-box result (Total legs 2-3) looks as it always did: its alternates, no delivery line.
  hybridAnswer = {
    result: { primary: boxes[0], alternates: [boxes[2], box("D", "Giants", "Cowboys", true, -115)], note: null, delivery: { requestedLegs: 3, deliveredLegs: 2, boxes: 1, qualifyingGames: 6, shortOfGames: false } },
    notes: [], candidateEvents: ["A", "C", "D"], eventSportKeys: { ...keys, D: "americanfootball_nfl" }, linkable: true, generatedAt: new Date().toISOString(),
  };
  await click(button("Generate parlay"));
  check("single box: the Primary / Alt 1 / Alt 2 tabs", ["Primary", "Alt 1", "Alt 2"].every((t) => Boolean(button(t))));
  check("single box: no delivery line, no game sections, the one-game header", !text().includes("Delivered") && gameSections().length === 0 && text().includes("2 legs · one game"));
  check("single box: Send to FanDuel is live", Boolean(button("Send to FanDuel")) && !(button("Send to FanDuel") as HTMLButtonElement).disabled);
  hybridAnswer = NO_BOX;
  await click(button("Generate parlay"));
  const hybridSent = hybridRequests.length;
  await click(button("Standard"));
  check("back on Standard: its controls and its leg count (25) are still there", text().includes("Max legs per game") && ctx.legCount === 25 && !text().includes("Hybrid builds from capper consensus"));
  check("flipping modes never regenerated anything", requests.length === standardRequests && hybridRequests.length === hybridSent);

  await act(() => root.unmount());
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
