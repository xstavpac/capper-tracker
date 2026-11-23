// Swapping one leg by hand on the page (PR B, the Swap modal): ParlayWorkspace on jsdom with the
// real slip provider, the real engine and the real session; only the server calls are stubbed (as in
// generator-favorites-ui-acceptance-test.ts). Pinned:
//   - one Swap button per leg card, no Primary / Hedge / Contrarian tabs or Swap scope on the page;
//     the legs heading and hint; cards strongest first; the banner's legs · games · leagues;
//   - the modal: title, Now strip, four tabs with counts equal to the rows, each tab's line, the
//     Current badge on the current pick (selected), Update Leg disabled until another pick;
//     Other games' league chips and note, several picks per game; the empty-tab copy;
//   - the footer's combined odds now -> new; Cancel and Escape change nothing;
//   - reduced motion: Update Leg replaces that leg at once, others untouched, Swapped tag, the banner
//     status, the combined price is combineOdds; reopening shows the new pick as Current;
//   - motion on: the overlay and "Re-scoring leg n" status, then the swap;
//   - no request for a swap; Send to FanDuel sends the current legs; Reset all puts the build back;
//     Regenerate clears the Swapped tags.
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
// and G3 / G4 are the Other games. Odds differ, so a swap moves the price. G3 also has a second
// capper's ML, weaker than any parlay leg: Other games lists several picks on one game.
const PICKS = [
  ...TEAMS.flatMap((_, g) => [mk(`g${g}ml`, g, "ML", 32 - g * 2, -150 + g * 5), mk(`g${g}o`, g, "OVER", 29 - g * 2, -105 - g * 5), mk(`g${g}u`, g, "UNDER", 27 - g * 2, 100 + g * 10)]),
  mk("g3ml2", 3, "ML", 25, -120),
  // A second Under on every game from a 12-28 capper: under the 55% gate. Same-game tabs list it
  // under "Below your gate" (collapsed); Other games never does.
  ...TEAMS.map((_, g) => mk(`g${g}low`, g, "UNDER", 12, 115)),
];
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
  const { combineOdds, formatAmericanOdds } = await import("@/lib/parlay/combine-odds");
  const { LEGS_HEADING, LEGS_HINT, SWAP_OVERLAY_MS, swappedStatus, swappingStatus } = await import("./generator-result");
  const { OTHER_GAMES_NOTE, SWAP_EMPTY, SWAP_TAB_HELP, SWAP_TAB_LABELS } = await import("@/lib/parlay/swap-modal");
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
  const modal = () => el.querySelector("[data-swap-modal]") as HTMLElement | null;
  const modals = () => el.querySelectorAll("[data-swap-modal]").length;
  const modalTabs = () => Array.from(modal()?.querySelectorAll('[role="tab"]') ?? []) as HTMLButtonElement[];
  const tabByKey = (key: string) => modal()?.querySelector(`[data-swap-tab="${key}"]`) as HTMLButtonElement | null;
  const rowIds = () => Array.from(modal()?.querySelectorAll("[data-swap-option]") ?? []).map((r) => r.getAttribute("data-swap-option")!);
  const tabCount = (key: string) => Number(tabByKey(key)?.querySelector("[data-swap-count]")?.textContent ?? "-1");
  const radio = (id: string) => modal()?.querySelector(`[data-swap-option="${id}"] input[type="radio"]`) as HTMLInputElement | null;
  const modalButton = (label: string) => Array.from(modal()?.querySelectorAll("button") ?? []).find((b) => (b.textContent ?? "").trim() === label || b.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;
  const choose = async (id: string) => {
    const r = radio(id);
    if (!r) throw new Error("no option " + id);
    await act(() => void r.click());
    await settle();
  };
  const legText = (i: number) => legRows()[i]?.textContent ?? "";
  const pickOf = (i: number) => PICKS.find((p) => legText(i).includes("Capper " + p.pickId + " ") || legText(i).includes("Capper " + p.pickId + "·") || new RegExp("Capper " + p.pickId + "(?![a-z0-9])").test(legText(i)))!;
  const shownPicks = () => legRows().map((_, i) => pickOf(i));
  const oddsShown = () => {
    const dt = Array.from(el.querySelectorAll("dt")).find((d) => (d.textContent ?? "").startsWith("Combined odds"));
    return dt?.nextElementSibling?.textContent ?? "";
  };

  await click(button("Generate parlay"));
  await waitUntil(() => text().includes("Your parlay is ready"), "the parlay");
  const before = shownPicks();
  check("fixture: 3 legs on G0-G2", before.length === 3 && before.every((p) => ["G0", "G1", "G2"].includes(p.gameId)), before.map((p) => p?.pickId).join(","));
  const requestsAfterBuild = requests.length;
  const builtIds = before.map((p) => p.pickId).join();
  const winsOf = (p: GeneratorPick) => Number(categoryRecords["cap-" + p.pickId + "|" + p.category]?.wins ?? 0);

  // ---- The page: one Swap per leg, no variant tabs ----
  check("every leg card has one Swap button", swapButtons().length === 3 && swapButtons().every((b) => (b.textContent ?? "").trim() === "Swap") && legRows().every((r) => r.querySelectorAll("[data-swap-button]").length === 1));
  check("no Primary / Hedge / Contrarian tabs and no Swap scope on the page", el.querySelectorAll('[role="tab"]').length === 0 && !text().includes("Swap:") && !text().includes("Swap is set to"));
  check("the legs heading and hint", text().includes(LEGS_HEADING) && text().includes(LEGS_HINT));
  check("cards strongest first (win % down the list)", before.every((p, i) => i === 0 || winsOf(before[i - 1]) >= winsOf(p)), before.map(winsOf).join(","));
  check("banner: 'N legs · N games · N leagues'", text().includes("3 legs · 3 games · 1 league"));

  // ---- The modal ----
  await click(swapButtons()[0]);
  check("open: one modal, a dialog titled 'Swap Leg 1'", modals() === 1 && modal()!.getAttribute("role") === "dialog" && (modal()!.textContent ?? "").includes("Swap Leg 1") && (modal()!.textContent ?? "").includes("Choose an alternative pick for this leg."));
  const now = modal()!.querySelector("[data-swap-now]")?.textContent ?? "";
  check("Now strip: the current pick, its capper, its odds", now.includes(before[0].betDetail) && now.includes("Capper " + before[0].pickId) && now.includes(String(before[0].odds)) && now.includes(before[0].gameLabel));
  check(
    "four tabs in order with counts",
    modalTabs().map((t) => t.getAttribute("data-swap-tab")).join() === "PRIMARY,HEDGE,CONTRARIAN,OTHER_GAMES" &&
      modalTabs().every((t) => (t.textContent ?? "").startsWith(SWAP_TAB_LABELS[t.getAttribute("data-swap-tab") as "PRIMARY"]))
  );
  check("opens on Primary, its line", tabByKey("PRIMARY")!.getAttribute("aria-selected") === "true" && (modal()!.querySelector("[data-swap-subtitle]")?.textContent ?? "") === SWAP_TAB_HELP.PRIMARY);
  check(
    "Primary: the current pick with the Current badge, selected",
    rowIds()[0] === before[0].pickId && Boolean(modal()!.querySelector(`[data-swap-option="${before[0].pickId}"] [data-current-badge]`)) && radio(before[0].pickId)!.checked
  );
  check("Update Leg disabled while the current pick is selected", modalButton("Update Leg")!.disabled);
  for (const key of ["PRIMARY", "HEDGE", "CONTRARIAN", "OTHER_GAMES"]) {
    await click(tabByKey(key));
    // The count is every row, the collapsed "Below your gate" group included.
    const hidden = Number((modal()!.querySelector("[data-below-gate-toggle]")?.textContent ?? "").match(/\((\d+)\)/)?.[1] ?? 0);
    check(`${key}: the count is the rows shown plus the collapsed below-gate rows (${rowIds().length} + ${hidden})`, tabCount(key) === rowIds().length + hidden, `count=${tabCount(key)} rows=${rowIds().length} hidden=${hidden}`);
    check(`${key}: every row shows its combined win %`, rowIds().every((id) => /Combined \d+(\.\d)?%/.test(modal()!.querySelector(`[data-swap-option="${id}"] [data-combined-win]`)?.textContent ?? "")));
    check(`${key}: its line`, (modal()!.querySelector("[data-swap-subtitle]")?.textContent ?? "") === SWAP_TAB_HELP[key as "PRIMARY"]);
  }
  await click(tabByKey("HEDGE"));
  const hedgeIds = rowIds();
  const leg1 = before[0];
  const onLegGame = (id: string) => PICKS.find((p) => p.pickId === id)!.gameId === leg1.gameId;
  const betTypeOf = (id: string) => PICKS.find((p) => p.pickId === id)!.betType;
  check("Hedge: picks on the leg's game in another market", hedgeIds.length > 0 && hedgeIds.every((id) => onLegGame(id) && betTypeOf(id) !== leg1.betType), hedgeIds.join(","));
  await click(tabByKey("CONTRARIAN"));
  const contrarianIds = rowIds();
  check(
    "Contrarian: the other side of the same bet only (an Over leg: its Under; an ML leg: none here)",
    leg1.betType === "TOTAL" ? contrarianIds.length === 1 && onLegGame(contrarianIds[0]) && betTypeOf(contrarianIds[0]) === "TOTAL" && contrarianIds[0] !== leg1.pickId : contrarianIds.length === 0,
    leg1.pickId + " -> " + contrarianIds.join(",")
  );
  await click(tabByKey("OTHER_GAMES"));
  const og = rowIds().map((id) => PICKS.find((p) => p.pickId === id)!);
  check("Other games: the gate only, no below-gate group", !og.some((p) => p.pickId.endsWith("low")) && modal()!.querySelector("[data-below-gate-toggle]") === null);
  check("Other games: never a game in the parlay, several per game", og.length > 0 && og.every((p) => ["G3", "G4"].includes(p.gameId)) && new Set(og.map((p) => p.gameId)).size < og.length, og.map((p) => p.pickId).join(","));
  check(
    "Other games: league chips (All + MLB) with counts, and the note",
    (modal()!.querySelector('[data-league-chip="ALL"]')?.textContent ?? "").replace(/\s/g, "") === "All" + og.length && Boolean(modal()!.querySelector('[data-league-chip="MLB"]')) && (modal()!.textContent ?? "").includes(OTHER_GAMES_NOTE)
  );
  check("Other games rows: league · matchup · time", (modal()!.querySelector("[data-swap-option]")?.textContent ?? "").includes(og[0].gameLabel));

  // Empty tabs: the copy, no rows - looked for on every leg (the fixture has some).
  let emptySeen = 0;
  let emptyOk = true;
  await click(modalButton("Close"));
  for (let i = 0; i < 3; i++) {
    await click(swapButtons()[i]);
    for (const key of ["HEDGE", "CONTRARIAN", "OTHER_GAMES"] as const) {
      if (tabCount(key) !== 0) continue;
      await click(tabByKey(key));
      emptySeen++;
      emptyOk = emptyOk && rowIds().length === 0 && (modal()!.querySelector("[data-swap-empty]")?.textContent ?? "") === SWAP_EMPTY[key];
    }
    await click(modalButton("Close"));
  }
  check("an empty tab shows its own copy and no rows", emptySeen > 0 && emptyOk, "empty tabs seen: " + emptySeen);
  await click(swapButtons()[0]);
  await click(tabByKey("OTHER_GAMES"));
  // Choosing a row: the footer's price moves, Update Leg turns on; Cancel changes nothing.
  await choose(og[0].pickId);
  const footer = (modal()!.querySelector("[data-swap-footer]")?.textContent ?? "").replace(/\s/g, "");
  const nowPrice = combineOdds(before);
  const nextPrice = combineOdds(before.map((p, i) => (i === 0 ? og[0] : p)));
  check(
    "footer: Combined odds now → new, $10 pays",
    nowPrice.status === "AVAILABLE" && nextPrice.status === "AVAILABLE" && footer.includes(formatAmericanOdds(nowPrice.american) + "→" + formatAmericanOdds(nextPrice.american)) && footer.includes("$10pays"),
    footer
  );
  check("Update Leg on once another pick is selected", !modalButton("Update Leg")!.disabled);
  await click(modalButton("Cancel"));
  check("Cancel closes the modal, nothing changes", modals() === 0 && shownPicks().map((p) => p.pickId).join() === builtIds);
  await click(swapButtons()[1]);
  await act(() => void win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" })));
  await settle();
  check("Escape closes the modal", modals() === 0);

  // ---- Update Leg, reduced motion (jsdom has no matchMedia): instant ----
  await click(swapButtons()[0]);
  await click(tabByKey("OTHER_GAMES"));
  const target = rowIds()[0];
  await choose(target);
  await click(modalButton("Update Leg"));
  check("reduced motion: replaced at once, the modal closed, no overlay", pickOf(0)?.pickId === target && modals() === 0 && el.querySelector("[data-swap-overlay]") === null, legText(0));
  check("the other legs stay exactly as they were", shownPicks().slice(1).map((p) => p.pickId).join() === before.slice(1).map((p) => p.pickId).join());
  check("the arrival highlight on the swapped leg only", Boolean(legRows()[0].hasAttribute("data-arrive")) && legRows().slice(1).every((r) => !r.hasAttribute("data-arrive")));
  check("a 'Swapped' tag on leg 1 only",Boolean(legRows()[0].querySelector("[data-swapped-tag]")) && legRows().slice(1).every((r) => !r.querySelector("[data-swapped-tag]")));
  check("banner status: 'Leg 1 swapped · Combined odds updated'", (el.querySelector("[data-swap-status]")?.textContent ?? "").includes(swappedStatus(1)));
  const c1 = combineOdds(shownPicks());
  check("combined price: combineOdds on the current legs", c1.status === "AVAILABLE" && oddsShown() === formatAmericanOdds(c1.american), `${oddsShown()} vs ${c1.status === "AVAILABLE" ? formatAmericanOdds(c1.american) : c1.status}`);
  check("no request for a swap", requests.length === requestsAfterBuild);

  // Reopening: the new pick is the current one; the one it replaced is offered again.
  await click(swapButtons()[0]);
  check("reopen: the swapped-in pick is Current and selected", rowIds()[0] === target && radio(target)!.checked && Boolean(modal()!.querySelector(`[data-swap-option="${target}"] [data-current-badge]`)));
  await click(tabByKey("OTHER_GAMES"));
  check("reopen: the replaced pick's game is an Other game now", rowIds().includes(before[0].pickId), rowIds().join(","));
  await click(modalButton("Close"));

  // ---- Motion on: the overlay and the status, then the swap ----
  (win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  await click(swapButtons()[1]);
  await click(tabByKey("HEDGE"));
  const motionTarget = rowIds()[0];
  await choose(motionTarget);
  await click(modalButton("Update Leg"));
  check("motion: the overlay 'Finding another eligible pick…' on leg 2", Boolean(legRows()[1].querySelector("[data-swap-overlay]")) && (legRows()[1].textContent ?? "").includes("Finding another eligible pick…"));
  check("motion: status 'Re-scoring leg 2 · Finding another eligible pick…'", text().includes(swappingStatus(2)));
  check("motion: no Swap button while a swap runs", swapButtons().length === 0);
  await act(async () => void (await tick(SWAP_OVERLAY_MS + 50)));
  await settle();
  check("motion: then the leg is replaced, the overlay gone", pickOf(1)?.pickId === motionTarget && el.querySelector("[data-swap-overlay]") === null && text().includes(swappedStatus(2)));
  await act(async () => void (await tick(700)));
  await settle();
  const c2 = combineOdds(shownPicks());
  check("motion: the combined price settles on combineOdds", c2.status === "AVAILABLE" && oddsShown() === formatAmericanOdds(c2.american), `${oddsShown()} vs ${c2.status === "AVAILABLE" ? formatAmericanOdds(c2.american) : c2.status}`);
  (win as unknown as { matchMedia?: unknown }).matchMedia = undefined;

  // ---- Send to FanDuel: the current legs ----
  const current = shownPicks().map((p) => p.pickId);
  await click(button("Send to FanDuel"));
  check("Send to FanDuel sends the current (swapped) legs", sent.length === 1 && [...sent[0]].sort().join() === [...current].sort().join(), JSON.stringify(sent));

  // ---- Reset all ----
  await click(button("Reset all"));
  check(
    "Reset all: the legs as built, no Swapped tags, no swap status",
    shownPicks().map((p) => p.pickId).join() === builtIds && el.querySelectorAll("[data-swapped-tag]").length === 0 && !text().includes("swapped · Combined odds updated"),
    shownPicks().map((p) => p.pickId).join()
  );
  check("Reset all: disabled with nothing swapped; no request", (button("Reset all") as HTMLButtonElement).disabled && requests.length === requestsAfterBuild);

  // ---- Below your gate: collapsed, dimmed, "NN% vs 55%", swappable and said so ----
  {
    await click(swapButtons()[0]);
    const low = `g${pickOf(0).gameId.slice(1)}low`;
    let lowTab: string | null = null;
    for (const key of ["PRIMARY", "HEDGE", "CONTRARIAN"]) {
      await click(tabByKey(key));
      if (modal()!.querySelector("[data-below-gate-toggle]")) {
        lowTab = key;
        break;
      }
    }
    check("below gate: the leg's game's 12-28 Under sits in one same-game tab's 'Below your gate' group, collapsed", lowTab !== null && !rowIds().includes(low) && modal()!.querySelector("[data-below-gate-toggle]")!.getAttribute("aria-expanded") === "false" && (modal()!.querySelector("[data-below-gate-toggle]")!.textContent ?? "").includes("Below your gate (1)"), String(lowTab));
    await click(modal()!.querySelector("[data-below-gate-toggle]"));
    const lowRow = modal()!.querySelector(`[data-swap-option="${low}"]`);
    check("below gate: expanded, the row is dimmed and reads 'Combined NN% vs 55%'", lowRow !== null && lowRow.hasAttribute("data-below-gate") && Boolean(lowRow.closest(".opacity-60")) && /Combined \d+(\.\d)?% vs 55%/.test(lowRow.querySelector("[data-combined-win]")?.textContent ?? ""), lowRow?.textContent ?? "none");
    await choose(low);
    check("below gate: choosing it says so in the footer, Update Leg on", (modal()!.querySelector("[data-swap-below-gate-note]")?.textContent ?? "").includes("below your gate (") && !modalButton("Update Leg")!.disabled);
    await click(modalButton("Update Leg"));
    const status = el.querySelector("[data-swap-status]")?.textContent ?? "";
    check("below gate: swapped in, the leg card tagged 'Below your gate · NN% vs 55%'", pickOf(0)?.pickId === low && /Below your gate · \d+(\.\d)?% vs 55%/.test(legRows()[0].querySelector("[data-below-gate-tag]")?.textContent ?? ""), legText(0));
    check("below gate: the confirmation says 'below your gate (NN% vs 55%)'", /Leg 1 swapped · below your gate \(\d+(\.\d)?% vs 55%\) · Combined odds updated/.test(status), status);
    await click(button("Reset all"));
    check("Reset all clears the below-gate tag", el.querySelectorAll("[data-below-gate-tag]").length === 0);
  }

  // ---- Regenerate clears the swap state ----
  await click(swapButtons()[2]);
  await click(tabByKey("OTHER_GAMES"));
  if (rowIds().length > 0) {
    await choose(rowIds()[0]);
    await click(modalButton("Update Leg"));
  } else await click(modalButton("Cancel"));
  const beforeRegen = new Set(shownPicks().map((p) => p.pickId));
  await click(button("Regenerate:Another parlay of comparable strength") ?? buttons().find((b) => (b.textContent ?? "").includes("Regenerate")));
  await waitUntil(() => text().includes("Your parlay is ready") && !text().includes("Regenerating…"), "the regenerated parlay");
  check("Regenerate: no Swapped tags, no modal, no swap status", el.querySelectorAll("[data-swapped-tag]").length === 0 && modals() === 0 && !text().includes("swapped · Combined odds updated"));
  {
    // Only the legs that differ from the parlay shown before the Regenerate land highlighted.
    const after = shownPicks();
    const lit = legRows().map((r) => r.hasAttribute("data-arrive"));
    const expected = after.map((p) => !beforeRegen.has(p.pickId));
    check(
      "Regenerate: the arrival highlight on the changed legs only (at least one changed, at least one kept)",
      JSON.stringify(lit) === JSON.stringify(expected) && expected.some(Boolean) && expected.some((x) => !x),
      `lit=${JSON.stringify(lit)} changed=${JSON.stringify(expected)}`
    );
  }

  await act(() => root.unmount());
  el.remove();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
