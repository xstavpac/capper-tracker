// The Parlay Generator's "Favorites only" star on the page (PR 2 of 3): ParlayWorkspace on jsdom with
// the real slip provider and the real engine; only the server calls are stubbed (as in
// generator-card-acceptance-test.ts). Pinned:
//   - the 48px round star in the Pick Filters header: label, title, aria-pressed, off / on styles;
//   - on: the Pick Filters subtitle and the Total legs helper change, nothing else in the panel;
//   - Generate with the star on sends favoritesOnly: true; with it off, no favoritesOnly at all;
//   - a toggle rebuilds the parlay with no request, from favorites only (slip picks stay);
//   - the result title's "★ Favorites" pill; the favorites empty state;
//   - remembered per user across a reload; hidden in Hybrid, and Hybrid's request never carries it;
//   - no favorites yet: "You haven't favorited any cappers yet." with a link to the Cappers tab.
// Pure - no DB. Run with:
//   npx tsx src/components/parlay/generator-favorites-ui-acceptance-test.ts
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
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
];
const categoryRecords: GeneratorSnapshot["categoryRecords"] = {};
function mk(id: string, g: number, kind: "ML" | "OVER", wins: number, favorite: boolean): GeneratorPick {
  const [home, away, nick] = TEAMS[g];
  const category = kind === "ML" ? "FAV_ML" : "OVER";
  categoryRecords["cap-" + id + "|" + category] = { key: category, label: category, wins, losses: 40 - wins, pushes: 0, winPct: (wins / 40) * 100, count: 40 };
  const detail = kind === "ML" ? nick + " ML" : "Over 8.5";
  return {
    pickId: id, capperId: "cap-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: favorite, category, leagueName: "MLB",
    gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: detail, odds: -110, units: 1, status: "PENDING",
    betType: kind === "OVER" ? "TOTAL" : "MONEYLINE", period: "FULL_GAME", rawBetDetail: detail, line: kind === "OVER" ? 8.5 : null,
    homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}
// Each game: a moneyline (favorite on G1 and G2 only) and an Over (never a favorite). The strongest picks are the
// non-favorites, so the star visibly changes the parlay.
const PICKS = TEAMS.flatMap((_, g) => [mk(`g${g}ml`, g, "ML", 26 - g, g === 1 || g === 2), mk(`g${g}o`, g, "OVER", 30 - g, false)]);
const games: GeneratorGame[] = TEAMS.map(([home, away], g) => ({ gameId: "G" + g, gameLabel: away + " @ " + home, gameTime: FUTURE, leagueName: "MLB", picks: PICKS.filter((p) => p.gameId === "G" + g) }));
// Swapped by a test to an all-non-favorite pool (the favorites empty state).
let pool: GeneratorGame[] = games;

const requests: GenerateRequest[] = [];
const hybridRequests: unknown[] = [];
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
      games: pool,
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
  hybridGenerateAction: async (req: unknown) => {
    hybridRequests.push(req);
    return { result: { primary: null, alternates: [], note: null, delivery: { requestedLegs: 3, deliveredLegs: 0, boxes: 0, qualifyingGames: 0, shortOfGames: true } }, notes: [], candidateEvents: [], eventSportKeys: {}, linkable: true, generatedAt: new Date().toISOString() };
  },
  hybridFanDuelLinkAction: async () => ({ error: "not used here" }),
});
stub("../../server/actions/picks", { getLeagueRecordsAction: async () => ({ records: {}, streaks: {}, last20: {} }) });
stub("../../server/actions/parlay-slip", {
  getSlipPickStatesAction: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: -110, kickoff: FUTURE, over: false, gameStatus: null }])),
});

const STAR = "Only use picks from my favorite cappers";

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
  buildGenerated = (await import("@/lib/parlay/generator")).buildGeneratedParlay;
  const React = await import("react");
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { ParlayPoolProvider } = await import("./parlay-pool-context");
  const { ParlayWorkspace } = await import("./parlay-workspace");
  const h = React.createElement;
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const settle = async () => {
    for (let i = 0; i < 4; i++) await act(async () => void (await tick()));
  };
  const waitUntil = async (cond: () => boolean, what: string, timeoutMs = 10_000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out after " + timeoutMs + "ms waiting for " + what);
      await act(async () => void (await tick()));
    }
  };
  const router = { push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {}, forward: () => {} };

  // One slip pick by a non-favorite capper: always a leg, star or not.
  win.localStorage.setItem("parlay-pool:u1", JSON.stringify({ version: 2, picks: [PICKS[1] as ExpanderPick], targets: [], excludedLeagues: [], legacy: { addMode: false, legCount: 3, checkedPicks: [] } }));

  let el!: HTMLDivElement;
  let root!: Root;
  const mount = async (hasFavorites: boolean) => {
    el = win.document.createElement("div");
    win.document.body.appendChild(el);
    root = createRoot(el);
    await act(() => root.render(h(AppRouterContext.Provider, { value: router as never }, h(ParlayPoolProvider, { userId: "u1", children: null }, h(ParlayWorkspace, { leagues: ["MLB"], hasFavorites })))));
    await settle();
  };
  const unmount = async () => {
    await act(() => root.unmount());
    el.remove();
  };
  const text = () => el.textContent ?? "";
  const buttons = () => Array.from(el.querySelectorAll("button"));
  const button = (label: string) => buttons().find((b) => (b.textContent ?? "").trim() === label || b.getAttribute("aria-label") === label);
  const click = async (b: Element | undefined) => {
    if (!b) throw new Error("no such control");
    await act(() => void (b as HTMLElement).click());
    await settle();
  };
  const star = () => button(STAR) as HTMLButtonElement | undefined;
  const filters = () => el.querySelector('section[aria-label="Pick Filters"]');
  const filtersHeader = () => filters()?.firstElementChild as HTMLElement | null;
  const generate = async () => {
    await click(button("Generate parlay"));
    await waitUntil(() => !text().includes("Generating…"), "Generating… to clear");
  };
  const legIds = () => Array.from(el.querySelectorAll("ol > li")).map((li) => li.textContent ?? "");
  const pill = () => el.querySelector("[data-favorites-pill]");

  await mount(true);

  // ---- The button, off ----
  const s0 = star();
  check("star: in the Pick Filters header row", Boolean(s0) && Boolean(filtersHeader()?.contains(s0!)));
  check("star: label and title", s0?.getAttribute("aria-label") === STAR && s0?.getAttribute("title") === STAR);
  check("star: off by default, aria-pressed=false", s0?.getAttribute("aria-pressed") === "false");
  check("star: 48px round", /\bh-12\b/.test(s0!.className) && /\bw-12\b/.test(s0!.className) && /\brounded-full\b/.test(s0!.className));
  check("star off: white background, light gray border, outline star", /\bbg-white\b/.test(s0!.className) && s0!.className.includes("border-[#DADDE5]") && s0!.querySelector("svg")?.getAttribute("fill") === "none");
  check("star off: the usual subtitle and helper", text().includes("Choose which games to build around, or use the full slate.") && /from your cappers\./.test(text()));
  const panelOff = filters()!.textContent!;

  await generate();
  check("Generate, star off: the request carries no favoritesOnly", requests.length === 1 && !("favoritesOnly" in requests[0].settings), JSON.stringify(requests[0]?.settings));
  const offLegs = legIds();
  check("star off: the parlay uses non-favorite cappers", offLegs.some((t) => t.includes("Capper g0o")), offLegs.join(" | "));
  check("star off: no ★ Favorites pill", pill() === null);

  // ---- On ----
  await click(star());
  const s1 = star()!;
  check("star on: aria-pressed=true", s1.getAttribute("aria-pressed") === "true");
  check("star on: amber background, amber border, filled amber star", s1.className.includes("bg-[#fff7e0]") && s1.className.includes("border-[#f5c451]") && s1.className.includes("text-[#f59e0b]") && s1.querySelector("svg")?.getAttribute("fill") === "currentColor");
  check("star on: subtitle 'Only picks from your favorite cappers.'", text().includes("Only picks from your favorite cappers.") && !text().includes("Choose which games to build around"));
  check("star on: helper '… from your favorite cappers.'", /from your favorite cappers\./.test(text()));
  const norm = (s: string) => s.replace("Only picks from your favorite cappers.", "Choose which games to build around, or use the full slate.").replace("from your favorite cappers.", "from your cappers.");
  check("star on: nothing else in the panel changes", norm(filters()!.textContent!) === panelOff);
  check("star on: rebuilt with no request", requests.length === 1, `requests=${requests.length}`);
  const onLegs = legIds();
  check("star on: the slip pick (a non-favorite) is still a leg", onLegs.some((t) => t.includes("Capper g0o")), onLegs.join(" | "));
  check("star on: every other leg is a favorite's (g1ml / g2ml)", onLegs.filter((t) => !t.includes("Capper g0o")).every((t) => t.includes("Capper g1ml") || t.includes("Capper g2ml")) && onLegs.length === 3, onLegs.join(" | "));
  check("star on: the result title shows the ★ Favorites pill", (pill()?.textContent ?? "").trim() === "★ Favorites" && Boolean(pill()?.closest("h2")?.textContent?.includes("Your parlay is ready")));
  check("star on: remembered for this user", win.localStorage.getItem("parlay-favorites-only:u1") === "1");

  // ---- Reload: still on ----
  await unmount();
  await mount(true);
  check("reload: the star is still on", star()?.getAttribute("aria-pressed") === "true" && text().includes("Only picks from your favorite cappers."));
  // A new page has no snapshot: Generate asks the server, with the star in the settings.
  await generate();
  check("Generate, star on: the request says favoritesOnly: true", requests.length === 2 && requests[1].settings.favoritesOnly === true, JSON.stringify(requests[1]?.settings));

  // ---- Hybrid: no star, and its request never carries it ----
  await click(button("Hybrid"));
  check("Hybrid: the star is hidden", star() === undefined);
  await click(button("Generate parlay"));
  check("Hybrid: its request has no favoritesOnly", hybridRequests.length === 1 && !JSON.stringify(hybridRequests[0]).includes("favoritesOnly"), JSON.stringify(hybridRequests[0]));
  await click(button("Standard"));
  check("back on Standard: the star is back, still on", star()?.getAttribute("aria-pressed") === "true");

  // ---- The favorites empty state: no favorite has a pick, no slip ----
  win.localStorage.setItem("parlay-pool:u1", JSON.stringify({ version: 2, picks: [], targets: [], excludedLeagues: [], legacy: { addMode: false, legCount: 3, checkedPicks: [] } }));
  await unmount();
  pool = games.map((gm) => ({ ...gm, picks: gm.picks.filter((p) => !p.capperIsFavorite) }));
  await mount(true);
  await generate();
  check(
    "star on, no favorite picks: the favorites empty-state copy",
    text().includes("None of your favorite cappers have picks that clear these filters right now. Turn off the star, add leagues or bet types, or lower the minimum win rate.") && !text().includes("No qualified picks"),
    text().slice(-300)
  );
  await click(star());
  check("star off again: the usual empty state is gone (there are picks)", !text().includes("None of your favorite cappers") && win.localStorage.getItem("parlay-favorites-only:u1") === null);
  await click(star());
  pool = games;

  // ---- No favorites yet ----
  await unmount();
  await mount(false);
  check("0 favorites: the star still toggles on", star()?.getAttribute("aria-pressed") === "true");
  const cappersLink = Array.from(filtersHeader()?.querySelectorAll("a") ?? []).find((a) => a.getAttribute("href") === "/cappers");
  check("0 favorites: 'You haven't favorited any cappers yet.' with a link to the Cappers tab", text().includes("You haven't favorited any cappers yet.") && Boolean(cappersLink) && !text().includes("Only picks from your favorite cappers."));
  await click(star());
  check("0 favorites, star off: the usual subtitle", text().includes("Choose which games to build around, or use the full slate.") && !text().includes("You haven't favorited"));

  await unmount();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
