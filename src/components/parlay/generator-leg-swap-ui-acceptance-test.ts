// Swapping one leg by hand on the page (PR 3 of 3): ParlayWorkspace on jsdom with the real slip
// provider, the real engine and the real session; only the server calls are stubbed (as in
// generator-favorites-ui-acceptance-test.ts). Pinned:
//   - a Swap pill on every leg of a built parlay, Primary tab only; "Close" + highlighted while open;
//     one tray at a time; Keep this leg closes it;
//   - the tray: header, "All cappers" / "★ Favorites only", This game | Other games with counts,
//     the subtitles, up to 3 rows (league · matchup · time, pick, capper record line, odds, Use),
//     the default tab, the empty-tab copy;
//   - reduced motion: Use replaces the leg at once (no overlay), "Swapped" tag, the status line,
//     the combined price is combineOdds on the current legs; Auto-pick takes the active tab's top row;
//   - motion on: the "Finding another eligible pick…" overlay and "Re-scoring leg n" status, then the swap;
//   - no request for a swap; Send to FanDuel sends the current legs; Regenerate clears the Swapped tags.
// Pure - no DB. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/components/parlay/generator-leg-swap-ui-acceptance-test.ts
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GenerateRequest } from "@/server/actions/parlay-generate";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const FUTURE = "2099-06-01T23:00:00.000Z";
const TEAMS: [string, string, string][] = [
  ["New York Yankees", "Boston Red Sox", "Yankees"],
  ["Toronto Blue Jays", "Tampa Bay Rays", "Blue Jays"],
  ["Houston Astros", "Baltimore Orioles", "Astros"],
  ["Cleveland Guardians", "Detroit Tigers", "Guardians"],
  ["Seattle Mariners", "Texas Rangers", "Mariners"],
];
const categoryRecords: GeneratorSnapshot["categoryRecords"] = {};
function mk(id: string, g: number, kind: "ML" | "OVER" | "UNDER", wins: number, odds: number): GeneratorPick {
  const [home, away, nick] = TEAMS[g];
  const category = kind === "ML" ? "FAV_ML" : kind;
  categoryRecords["cap-" + id + "|" + category] = { key: category, label: category, wins, losses: 40 - wins, pushes: 0, winPct: (wins / 40) * 100, count: 40 };
  const detail = kind === "ML" ? nick + " ML" : kind === "OVER" ? "Over 8.5" : "Under 8.5";
  return {
    pickId: id, capperId: "cap-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category, leagueName: "MLB",
    gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: detail, odds, units: 1, status: "PENDING",
    betType: kind === "ML" ? "MONEYLINE" : "TOTAL", period: "FULL_GAME", rawBetDetail: detail, line: kind === "ML" ? null : 8.5,
    homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}
// Every game: ML, Over, Under (opposes the Over). G0-G2 are the strongest, so a 3-leg parlay is on them
// and G3 / G4 are the Other games. Odds differ, so a swap moves the price.
const PICKS = TEAMS.flatMap((_, g) => [mk(`g${g}ml`, g, "ML", 32 - g * 2, -150 + g * 5), mk(`g${g}o`, g, "OVER", 29 - g * 2, -105 - g * 5), mk(`g${g}u`, g, "UNDER", 27 - g * 2, 100 + g * 10)]);
const games: GeneratorGame[] = TEAMS.map(([home, away], g) => ({ gameId: "G" + g, gameLabel: away + " @ " + home, gameTime: FUTURE, leagueName: "MLB", picks: PICKS.filter((p) => p.gameId === "G" + g) }));

const requests: GenerateRequest[] = [];
let buildGenerated: typeof import("@/lib/parlay/generator").buildGeneratedParlay | null = null;
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-generate", {
  generateParlayAction: async (req: GenerateRequest) => {
    requests.push(JSON.parse(JSON.stringify(req)));
    if (!buildGenerated) throw new Error("generator not preloaded");
    const snapshot: GeneratorSnapshot = {
      builtAt: new Date().toISOString(),
      games,
      slipPicks: req.slipPickIds.map((id) => PICKS.find((p) => p.pickId === id)!),
      targets: [],
      leagueRecords: { records: {}, streaks: {}, last20: {} },
      categoryRecords,
    };
    return { snapshot, parlay: buildGenerated(snapshot, req.settings, null, new Date()) };
  },
});
stub("../../server/actions/parlay-run-log", { recordGeneratorRunAction: async () => undefined });
stub("../../server/actions/parlay-hybrid", {
  hybridGenerateAction: async () => ({ error: "not used here" }),
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
  // The odds tween (motion on) steps on animation frames.
  g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  const sent: string[][] = [];
  g.fetch = async (_url: string, init: { body: string }) => {
    const { pickIds } = JSON.parse(init.body) as { pickIds: string[] };
    sent.push(pickIds);
    return { ok: true, json: async () => ({ legs: pickIds.map((pickId) => ({ pickId, status: "matched", fanDuelOdds: -110, pickOdds: -110, sentLine: null })), url: "https://fanduel.example/betslip" }) };
  };
  buildGenerated = (await import("@/lib/parlay/generator")).buildGeneratedParlay;
  const { combineOdds, formatDecimalOdds } = await import("@/lib/parlay/combine-odds");
  const { SWAP_EMPTY, SWAP_OVERLAY_MS, swappedStatus, swappingStatus } = await import("./generator-result");
  const React = await import("react");
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { ParlayPoolProvider } = await import("./parlay-pool-context");
  const { ParlayWorkspace } = await import("./parlay-workspace");
  const h = React.createElement;
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => {
    for (let i = 0; i < 4; i++) await act(async () => void (await tick()));
  };
  const waitUntil = async (cond: () => boolean, what: string, timeoutMs = 10_000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out after " + timeoutMs + "ms waiting for " + what);
      await act(async () => void (await tick(10)));
    }
  };
  const router = { push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {}, forward: () => {} };
  win.localStorage.setItem("parlay-pool:u1", JSON.stringify({ version: 2, picks: [], targets: [], excludedLeagues: [], legacy: { addMode: false, legCount: 3, checkedPicks: [] } }));

  const el = win.document.createElement("div");
  win.document.body.appendChild(el);
  const root: Root = createRoot(el);
  await act(() => root.render(h(AppRouterContext.Provider, { value: router as never }, h(ParlayPoolProvider, { userId: "u1", children: null }, h(ParlayWorkspace, { leagues: ["MLB"], hasFavorites: false })))));
  await settle();

  const text = () => el.textContent ?? "";
  const buttons = () => Array.from(el.querySelectorAll("button"));
  const button = (label: string) => buttons().find((b) => (b.textContent ?? "").trim() === label || b.getAttribute("aria-label") === label);
  const click = async (b: Element | undefined | null) => {
    if (!b) throw new Error("no such control");
    await act(() => void (b as HTMLElement).click());
    await settle();
  };
  const legRows = () => Array.from(el.querySelectorAll("ol > li")) as HTMLElement[];
  const swapButtons = () => Array.from(el.querySelectorAll("[data-swap-button]")) as HTMLButtonElement[];
  const tray = () => el.querySelector("[data-swap-tray]") as HTMLElement | null;
  const trays = () => el.querySelectorAll("[data-swap-tray]").length;
  const trayTabs = () => Array.from(tray()?.querySelectorAll('[role="tab"]') ?? []) as HTMLButtonElement[];
  const rowIds = () => Array.from(tray()?.querySelectorAll("[data-swap-alternative]") ?? []).map((r) => r.getAttribute("data-swap-alternative")!);
  const legText = (i: number) => legRows()[i]?.textContent ?? "";
  const pickOf = (i: number) => PICKS.find((p) => legText(i).includes("Capper " + p.pickId + " ") || legText(i).includes("Capper " + p.pickId + "·") || new RegExp("Capper " + p.pickId + "(?![a-z0-9])").test(legText(i)))!;
  const shownPicks = () => legRows().map((_, i) => pickOf(i));
  const decimalShown = () => {
    const dt = Array.from(el.querySelectorAll("dt")).find((d) => d.textContent === "Decimal");
    return dt?.nextElementSibling?.textContent ?? "";
  };

  await click(button("Generate parlay"));
  await waitUntil(() => text().includes("Your parlay is ready"), "the parlay");
  const before = shownPicks();
  check("fixture: 3 legs on G0-G2", before.length === 3 && before.every((p) => ["G0", "G1", "G2"].includes(p.gameId)), before.map((p) => p?.pickId).join(","));
  const requestsAfterBuild = requests.length;

  // ---- The Swap pills ----
  check("every leg has a Swap pill under its odds", swapButtons().length === 3 && swapButtons().every((b) => (b.textContent ?? "").trim() === "Swap"));
  check("Swap pill: a tap target of at least 40px (the 10px hit area above and below)", swapButtons().every((b) => b.className.includes("after:-inset-y-2.5")));
  await click(swapButtons()[0]);
  check("open: one tray, under leg 1", trays() === 1 && Boolean(legRows()[0].contains(tray())));
  check("open: leg 1's button reads Close, highlighted, aria-expanded", (swapButtons()[0].textContent ?? "").trim() === "Close" && swapButtons()[0].className.includes("bg-brand-600") && swapButtons()[0].getAttribute("aria-expanded") === "true");
  const t = tray()!.textContent ?? "";
  check("tray header and capper scope", t.includes("Swap leg 1 · eligible picks not already in this parlay") && t.includes("All cappers"));
  const tabs = trayTabs();
  check("tray tabs: This game | Other games with counts", tabs.length === 2 && /^This game\d+$/.test((tabs[0].textContent ?? "").replace(/\s/g, "").replace("Thisgame", "This game")) && (tabs[1].textContent ?? "").startsWith("Other games"), tabs.map((x) => x.textContent).join(" | "));
  check("tray tabs: at least 40px tall (h-10)", tabs.every((x) => /\bh-10\b/.test(x.className)));
  check("default tab: This game (it has alternatives)", tabs[0].getAttribute("aria-selected") === "true");
  check("This game subtitle", t.includes("Other eligible picks on " + before[0].gameLabel));
  check("This game rows: only leg 1's game, never a pick in the parlay", rowIds().length > 0 && rowIds().length <= 3 && rowIds().every((id) => PICKS.find((p) => p.pickId === id)!.gameId === before[0].gameId && !before.some((b) => b.pickId === id)), rowIds().join(","));
  const firstRow = tray()!.querySelector("[data-swap-alternative]")!;
  const fr = PICKS.find((p) => p.pickId === rowIds()[0])!;
  check(
    "a row: league · matchup · time, pick, capper record line, odds, Use",
    (firstRow.textContent ?? "").includes("MLB · " + fr.gameLabel) && (firstRow.textContent ?? "").includes(fr.betDetail) && (firstRow.textContent ?? "").includes("Capper " + fr.pickId + " · ") && /\(\d+–\d+\)/.test(firstRow.textContent ?? "") && (firstRow.textContent ?? "").includes(String(fr.odds)) && Boolean(Array.from(firstRow.querySelectorAll("button")).find((b) => b.textContent === "Use"))
  );
  check("tray buttons: at least 40px tall", Array.from(tray()!.querySelectorAll("button")).filter((b) => b.getAttribute("role") !== "tab").every((b) => b.className.includes("min-h-[40px]")));
  await click(trayTabs()[1]);
  check("Other games subtitle", (tray()!.textContent ?? "").includes(`Replaces ${before[0].gameLabel} with a game not in your parlay`));
  check("Other games rows: never a game in the parlay", rowIds().length > 0 && rowIds().every((id) => ["G3", "G4"].includes(PICKS.find((p) => p.pickId === id)!.gameId)), rowIds().join(","));
  const otherTop = rowIds()[0];

  // One tray at a time.
  await click(swapButtons()[1]);
  check("opening leg 2's tray closes leg 1's", trays() === 1 && Boolean(legRows()[1].contains(tray())) && (swapButtons()[0].textContent ?? "").trim() === "Swap");
  await click(button("Keep this leg"));
  check("Keep this leg closes the tray, nothing changes", trays() === 0 && shownPicks().map((p) => p.pickId).join() === before.map((p) => p.pickId).join());

  // ---- Use, reduced motion (jsdom has no matchMedia): instant ----
  await click(swapButtons()[0]);
  const thisTop = rowIds()[0];
  await click(Array.from(tray()!.querySelectorAll("button")).find((b) => b.textContent === "Use"));
  check("reduced motion: replaced at once, no overlay", pickOf(0)?.pickId === thisTop && el.querySelector("[data-swap-overlay]") === null, legText(0));
  check("the other legs stay exactly as they were", shownPicks().slice(1).map((p) => p.pickId).join() === before.slice(1).map((p) => p.pickId).join());
  check("a 'Swapped' tag on leg 1 only", Boolean(legRows()[0].querySelector("[data-swapped-tag]")) && legRows().slice(1).every((r) => !r.querySelector("[data-swapped-tag]")));
  check("status: 'Leg 1 swapped · Combined odds updated'", text().includes(swappedStatus(1)));
  const c1 = combineOdds(shownPicks());
  check("combined price: combineOdds on the current legs", c1.status === "AVAILABLE" && decimalShown() === formatDecimalOdds(c1.decimal), `${decimalShown()} vs ${c1.status === "AVAILABLE" ? formatDecimalOdds(c1.decimal) : c1.status}`);
  check("no request for a swap", requests.length === requestsAfterBuild);

  // Swap the same leg again: the pick it replaced is offered, the one in the leg isn't.
  await click(swapButtons()[0]);
  check("swap again: the leg's current pick isn't in its tray, the replaced one is", !rowIds().includes(thisTop) && rowIds().includes(before[0].pickId), rowIds().join(","));
  // Auto-pick uses the active tab: switch to Other games first.
  await click(trayTabs()[1]);
  const autoTarget = rowIds()[0];
  await click(button("Auto-pick next best"));
  check("Auto-pick: the active tab's (Other games') top row", pickOf(0)?.pickId === autoTarget && autoTarget === otherTop, `${pickOf(0)?.pickId} vs ${autoTarget}`);
  check("Other-games swap: leg 1's game has left the parlay", !shownPicks().some((p) => p.gameId === before[0].gameId));

  // ---- Motion on: the overlay and the status, then the swap ----
  (win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  await click(swapButtons()[1]);
  const motionTarget = rowIds()[0];
  await click(Array.from(tray()!.querySelectorAll("button")).find((b) => b.textContent === "Use"));
  check("motion: the white overlay 'Finding another eligible pick…' on leg 2", Boolean(legRows()[1].querySelector("[data-swap-overlay]")) && (legRows()[1].textContent ?? "").includes("Finding another eligible pick…"));
  check("motion: status 'Re-scoring leg 2 · Finding another eligible pick…'", text().includes(swappingStatus(2)));
  check("motion: no Swap pill while a swap runs", swapButtons().length === 0);
  await act(async () => void (await tick(SWAP_OVERLAY_MS + 50)));
  await settle();
  check("motion: then the leg is replaced, the overlay gone", pickOf(1)?.pickId === motionTarget && el.querySelector("[data-swap-overlay]") === null && text().includes(swappedStatus(2)));
  await act(async () => void (await tick(700)));
  await settle();
  const c2 = combineOdds(shownPicks());
  check("motion: the combined price settles on combineOdds", c2.status === "AVAILABLE" && decimalShown() === formatDecimalOdds(c2.decimal), `${decimalShown()} vs ${c2.status === "AVAILABLE" ? formatDecimalOdds(c2.decimal) : c2.status}`);
  (win as unknown as { matchMedia?: unknown }).matchMedia = undefined;

  // ---- Hedge / Contrarian: no Swap pills there ----
  await click(buttons().find((b) => b.getAttribute("role") === "tab" && (b.textContent ?? "").startsWith("Hedge")));
  check("Hedge tab: no per-leg Swap", swapButtons().length === 0);
  await click(buttons().find((b) => b.getAttribute("role") === "tab" && (b.textContent ?? "").startsWith("Primary")));
  check("back on Primary: the swapped legs are still there", (swapButtons().length === 3) && pickOf(0)?.pickId === autoTarget);

  // ---- Send to FanDuel: the current legs ----
  const current = shownPicks().map((p) => p.pickId);
  await click(button("Send to FanDuel"));
  check("Send to FanDuel sends the current (swapped) legs", sent.length === 1 && sent[0].join() === current.join(), JSON.stringify(sent));

  // ---- An empty tab ----
  // Every Other game is now used up by the two swaps? Not necessarily - check the copy when one is empty.
  await click(swapButtons()[2]);
  const empty = tray()!.querySelector("[data-swap-empty]");
  const counts = trayTabs().map((x) => Number((x.textContent ?? "").replace(/\D/g, "")));
  check("tab counts match the rows available", rowIds().length === Math.min(3, counts[trayTabs().findIndex((x) => x.getAttribute("aria-selected") === "true")]));
  if (counts[1] === 0) {
    await click(trayTabs()[1]);
    check("empty Other games: its copy", (tray()!.querySelector("[data-swap-empty]")?.textContent ?? "") === SWAP_EMPTY.OTHER_GAMES);
  } else check("empty-tab copy hidden when the tab has rows", empty === null);
  await click(button("Keep this leg"));

  // ---- Regenerate clears the swap state ----
  await click(button("Regenerate: Another parlay of comparable strength") ?? buttons().find((b) => (b.textContent ?? "").includes("Regenerate")));
  await waitUntil(() => text().includes("Your parlay is ready") && !text().includes("Regenerating…"), "the regenerated parlay");
  check("Regenerate: no Swapped tags, no tray, no swap status", el.querySelectorAll("[data-swapped-tag]").length === 0 && trays() === 0 && !text().includes("swapped · Combined odds updated"));

  await act(() => root.unmount());
  el.remove();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
