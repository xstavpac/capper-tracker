// The Parlay Generator's pick-by-pick build (build-reveal.ts, use-build-reveal.ts,
// generator-result.tsx) on jsdom with motion allowed, the real slip provider and the
// real engine; only the server calls are stubbed, as in generator-card-acceptance-test.ts.
// Real timers: the build takes ~4s per run here.
//   - the schedule: gap = clamp(6500 / N, 420, 780), the whole build within ~7s,
//     generic status text only;
//   - analyzing -> building -> complete on Generate and on Regenerate, the counter,
//     the progress bar, the status line, the odds row under the legs landing on the
//     engine's own combined price, PARLAY COMPLETE with Send to FanDuel inside;
//   - one card and one row per leg from start to finish (no remount while revealing);
//   - Clear result mid-build, Generate mid-build, unmount mid-build, reduced motion.
// Pure - no DB. Run with:
//   npx tsx src/components/parlay/generator-build-reveal-acceptance-test.ts
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GenerateRequest } from "@/server/actions/parlay-generate";
import { ANALYZE_MIN_MS, ANALYZING_STATUS, BUILD_BUDGET_MS, completeText, GAP_MIN_MS, LAND_MS, ODDS_TWEEN_MS, findingStatus, revealGap, revealSchedule } from "@/lib/parlay/build-reveal";
import { combineOdds, formatAmericanOdds } from "@/lib/parlay/combine-odds";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// ---- The schedule (pure) ----
check("gap: 780ms for small parlays", revealGap(1) === 780 && revealGap(3) === 780 && revealGap(8) === 780);
check("gap: 6500 / N in between", revealGap(10) === 650 && revealGap(13) === 500);
check("gap: never under 420ms", revealGap(20) === 420 && revealGap(25) === 420);
for (const n of [1, 3, 8, 12, 25]) {
  const steps = revealSchedule(n);
  const lands = steps.filter((s) => s.kind === "land");
  const done = steps.find((s) => s.kind === "complete")!;
  const inOrder = lands.every((s, i) => s.kind === "land" && s.index === i && (i === 0 || s.at > lands[i - 1].at));
  // clamp(6500 / N, 420, 780): ~6.5s of legs up to 15; past that the 420ms floor wins (25 legs: 10.5s).
  const bound = n <= 15 ? BUILD_BUDGET_MS : n * GAP_MIN_MS;
  check(`schedule · ${n} legs: every leg lands once, in order, the legs in ${bound}ms`, lands.length === n && inOrder && lands[n - 1].at <= bound && done.at === lands[n - 1].at + Math.max(LAND_MS, ODDS_TWEEN_MS), `last leg=${lands[n - 1].at} end=${done.at}`);
  const statusFirst = steps.filter((s) => s.kind === "status").every((s) => s.at < lands[s.index].at && s.at > (s.index === 0 ? 0 : lands[s.index - 1].at));
  check(`schedule · ${n} legs: each status line comes between the last leg and the next`, statusFirst);
}
check("status: first and final", findingStatus(0, 5) === "Finding strongest available pick…" && findingStatus(4, 5) === "Finding final pick…" && findingStatus(0, 1) === "Finding strongest available pick…");
check("complete: all N; short of Total legs says how many matched", completeText(3, 3) === "All 3 selections assembled." && completeText(2, 4) === "All 2 selections assembled. Only 2 eligible picks matched your filters.");

// ---- The card (jsdom) ----
const FUTURE = "2099-06-01T23:00:00.000Z";
const TEAMS: [string, string, string][] = [
  ["New York Yankees", "Boston Red Sox", "Yankees"],
  ["Toronto Blue Jays", "Tampa Bay Rays", "Blue Jays"],
  ["Houston Astros", "Baltimore Orioles", "Astros"],
  ["Cleveland Guardians", "Detroit Tigers", "Guardians"],
];
const ODDS = [-150, 120, -110, 135];
const categoryRecords: GeneratorSnapshot["categoryRecords"] = {};
function mk(g: number, wins: number): GeneratorPick {
  const [home, away, nick] = TEAMS[g];
  const id = `g${g}ml`;
  categoryRecords["cap-" + id + "|FAV_ML"] = { key: "FAV_ML", label: "FAV_ML", wins, losses: 40 - wins, pushes: 0, winPct: (wins / 40) * 100, count: 40 };
  return {
    pickId: id, capperId: "cap-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category: "FAV_ML", leagueName: "MLB",
    gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: nick + " ML", odds: ODDS[g], units: 1, status: "PENDING",
    betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: nick + " ML", line: null,
    homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}
const PICKS = TEAMS.map((_, g) => mk(g, 30 - g));
const games: GeneratorGame[] = TEAMS.map(([home, away], g) => ({ gameId: "G" + g, gameLabel: away + " @ " + home, gameTime: FUTURE, leagueName: "MLB", picks: PICKS.filter((p) => p.gameId === "G" + g) }));

const requests: GenerateRequest[] = [];
let buildGenerated: typeof import("@/lib/parlay/generator").buildGeneratedParlay | null = null;
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-generate", {
  generateParlayAction: async (req: GenerateRequest) => {
    requests.push(req);
    const snapshot: GeneratorSnapshot = { builtAt: new Date().toISOString(), games, slipPicks: [], targets: [], leagueRecords: { records: {}, streaks: {}, last20: {} }, categoryRecords };
    return { snapshot, parlay: buildGenerated!(snapshot, req.settings, null, new Date()) };
  },
});
stub("../../server/actions/parlay-run-log", { recordGeneratorRunAction: async () => undefined });
stub("../../server/actions/parlay-hybrid", { hybridGenerateAction: async () => ({ error: "not used here" }), hybridFanDuelLinkAction: async () => ({ error: "not used here" }) });
stub("../../server/actions/picks", { getLeagueRecordsAction: async () => ({ records: {}, streaks: {}, last20: {} }) });
stub("../../server/actions/parlay-slip", { getSlipPickStatesAction: async () => ({}) });

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/parlay", pretendToBeVisual: true });
  const win = dom.window;
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.self = win;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  g.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  g.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // Motion allowed unless a check turns reduced motion on.
  let reduceMotion = false;
  (win as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: q.includes("reduce") && reduceMotion, media: q, addEventListener() {}, removeEventListener() {} });
  const scrolled: string[] = [];
  win.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, opts?: ScrollIntoViewOptions | boolean) {
    scrolled.push((typeof opts === "object" ? opts.block : "") + ":" + (this.hasAttribute("data-parlay-complete") ? "banner" : this.className.includes("scroll-mt-4") ? "card" : "odds"));
  };
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a[0]);
    origError(...a);
  };

  buildGenerated = (await import("@/lib/parlay/generator")).buildGeneratedParlay;
  const React = await import("react");
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { ParlayPoolProvider } = await import("./parlay-pool-context");
  const { ParlayWorkspace } = await import("./parlay-workspace");
  const h = React.createElement;
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());
  const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
  const router = { push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {}, forward: () => {} };

  const el = win.document.createElement("div");
  win.document.body.appendChild(el);
  const text = () => el.textContent ?? "";
  const button = (label: string) => Array.from(el.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === label || (b.getAttribute("aria-label") ?? "").startsWith(label));
  const click = async (label: string) => {
    const b = button(label);
    if (!b) throw new Error("no such control: " + label);
    await act(() => void b.click());
  };
  // The result card: the panel holding the progress bar or the leg list after the generator's own panel.
  const card = () => Array.from(el.querySelectorAll("section")).find((s) => /Building your parlay|Your parlay is ready/.test(s.querySelector("h2")?.textContent ?? "")) ?? null;
  const title = () => card()?.querySelector("h2")?.textContent ?? "";
  const counter = () => {
    const chips = Array.from(card()?.querySelectorAll("span") ?? []).map((s) => s.textContent ?? "");
    return chips.find((t) => /^\d+ \/ \d+$/.test(t) || /^\d+ legs$/.test(t)) ?? "";
  };
  const status = () => card()?.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? "";
  const progress = () => Number(card()?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") ?? -1);
  const rows = () => Array.from(card()?.querySelectorAll("ol > li:not([data-placeholder-leg])") ?? []);
  const placeholders = () => card()?.querySelectorAll("[data-placeholder-leg]").length ?? 0;
  const odds = () => /Combined odds(?: \(estimate\))?([+-][\d,]+)/.exec(card()?.textContent ?? "")?.[1] ?? null;
  const waitFor = async (cond: () => boolean, what: string, timeoutMs = 8000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for " + what + " · " + title() + " · " + counter() + " · " + status());
      await wait(20);
    }
  };

  const root: Root = createRoot(el);
  await act(() => root.render(h(AppRouterContext.Provider, { value: router as never }, h(ParlayPoolProvider, { userId: "u1", children: null }, h(ParlayWorkspace, { leagues: ["MLB"] })))));
  await wait(20);

  // ---- Generate: analyzing ----
  const t0 = Date.now();
  await click("Generate parlay");
  check("Generate: the result card appears at once, 'Building your parlay'", title() === "Building your parlay", title());
  const theCard = card();
  check("analyzing: counter 0 / N, empty bar, the analyzing status, two placeholder legs", /^0 \/ \d+$/.test(counter()) && progress() === 0 && status() === ANALYZING_STATUS && placeholders() === 2 && rows().length === 0, `${counter()} ${progress()} ${status()} ${placeholders()}`);
  check("analyzing: no Regenerate, no tabs, no Send to FanDuel yet", !button("Regenerate") && !el.querySelector('[role="tab"]') && !button("Send to FanDuel"));
  check("analyzing: the page scrolls to the card", scrolled.includes("start:card"), scrolled.join());
  await wait(ANALYZE_MIN_MS - 250);
  check("analyzing lasts ~1s even when the server answers sooner", rows().length === 0 && status() === ANALYZING_STATUS);

  // ---- Building ----
  const statuses = new Set<string>();
  const oddsSeen: string[] = [];
  const firstRowSeen: Element[] = [];
  let sameCard = true;
  let counterOk = true;
  while (title() !== "Your parlay is ready") {
    if (Date.now() - t0 > 9000) break;
    if (card() !== theCard) sameCard = false;
    statuses.add(status());
    const o = odds();
    if (o && oddsSeen[oddsSeen.length - 1] !== o) oddsSeen.push(o);
    if (rows()[0]) firstRowSeen.push(rows()[0]);
    const c = counter();
    if (title() === "Building your parlay" && /^\d+ \/ \d+$/.test(c) && Number(c.split(" / ")[0]) !== rows().length) counterOk = false;
    await wait(15);
  }
  const elapsed = Date.now() - t0;
  const legs = rows().length;
  check("complete: 'Your parlay is ready' within ~7s", title() === "Your parlay is ready" && elapsed < 7500, `elapsed=${elapsed}ms legs=${legs}`);
  check("one card from analyzing to complete (keyed on the build, not the legs shown)", sameCard && card() === theCard);
  check("one row per leg: leg 1 never remounts while the others land", firstRowSeen.length > 0 && firstRowSeen.every((r) => r === firstRowSeen[0]) && rows()[0] === firstRowSeen[0]);
  check("building: the counter is the legs shown", counterOk);
  const allowed = new Set([ANALYZING_STATUS, "Finding strongest available pick…", "Finding next pick…", "Checking markets and capper records…", "Scanning remaining games…", "Comparing eligible picks…", "Finding final pick…", ...Array.from({ length: 25 }, (_, i) => `Adding selection ${i + 1} · Calculating combined odds`), `${legs} of ${legs} selections added`]);
  check("status lines: generic process text only, never a team or a capper", [...statuses].every((s) => allowed.has(s)) && statuses.has("Finding strongest available pick…") && statuses.has("Finding final pick…") && statuses.has("Adding selection 1 · Calculating combined odds"), JSON.stringify([...statuses]));
  check("auto-follow: the odds row is scrolled into view (nearest) as legs land", scrolled.filter((s) => s === "nearest:odds").length >= legs - 1, scrolled.join());

  // ---- Complete ----
  const shownDetails = rows().map((r) => r.querySelector("p.text-\\[15px\\]")?.textContent ?? "");
  const finalPrice = formatAmericanOdds((combineOdds(PICKS.filter((p) => shownDetails.includes(p.betDetail))) as { american: number }).american);
  check("complete: the odds row lands exactly on the engine's combined price", odds() === finalPrice, `shown=${odds()} expected=${finalPrice} seen=${oddsSeen.join(" → ")}`);
  check("complete: the price moved leg by leg (from each combined value to the next)", oddsSeen.length >= 2, oddsSeen.join(" → "));
  check("complete: counter back to 'N legs', bar full, dot still", counter() === `${legs} legs` && progress() === legs && !card()?.querySelector('[role="status"] .animate-pulse'));
  check("complete: scan line gone", !card()?.querySelector(".animate-build-scan"));
  check("complete: Regenerate, mode picker, tabs back", Boolean(button("Regenerate")) && Boolean(el.querySelector('[aria-label="Regenerate mode"]')) && el.querySelectorAll('[role="tab"]').length === 3);
  const banner = card()?.querySelector("[data-parlay-complete]");
  check("complete: PARLAY COMPLETE under the odds row, Send to FanDuel inside it", Boolean(banner) && (banner?.textContent ?? "").includes(completeText(legs, legs)) && Boolean(Array.from(banner?.querySelectorAll("button") ?? []).find((b) => b.textContent === "Send to FanDuel")));
  const order = Array.from(card()?.querySelectorAll("ol, [data-parlay-complete], dl") ?? []).map((n) => n.tagName.toLowerCase() === "ol" ? "legs" : n.tagName.toLowerCase() === "dl" ? "odds" : "banner");
  check("order: leg list, then the odds row, then the banner", order.join() === "legs,odds,banner", order.join());
  check("only one request for the Generate", requests.length === 1, `requests=${requests.length}`);

  // ---- Regenerate runs the sequence too (no request) ----
  await click("Regenerate");
  check("Regenerate: building again, no request", title() === "Building your parlay" && requests.length === 1, title());
  await waitFor(() => title() === "Your parlay is ready", "Regenerate to complete");
  check("Regenerate: completes with its legs", rows().length > 0);

  // ---- Clear result mid-build ----
  await click("Generate parlay");
  await waitFor(() => rows().length >= 1, "a leg");
  await click("Clear result");
  check("Clear result mid-build: the card is gone", card() === null);
  await wait(3000);
  check("...and no timer brings it back", card() === null && !text().includes("Building your parlay"));

  // ---- Generate mid-build: the old sequence stops, the new one starts over ----
  await click("Generate parlay");
  await waitFor(() => rows().length >= 2, "two legs");
  await waitFor(() => !button("Generate parlay")?.disabled, "Generate enabled");
  await click("Generate parlay");
  check("Generate mid-build: back to 0, analyzing", /^0 \/ \d+$/.test(counter()) && rows().length === 0 && status() === ANALYZING_STATUS, `${counter()} ${rows().length}`);
  let maxRows = 0;
  let restartsClean = true;
  let last = 0;
  while (title() !== "Your parlay is ready") {
    const n = rows().length;
    if (n < last) restartsClean = false;
    last = n;
    maxRows = Math.max(maxRows, n);
    await wait(15);
  }
  check("...one sequence: the legs only ever grow, to the parlay's size", restartsClean && maxRows === rows().length, `max=${maxRows} final=${rows().length}`);

  // ---- Reduced motion: the result at once ----
  reduceMotion = true;
  await click("Generate parlay");
  await wait(30);
  check("reduced motion: 'Your parlay is ready' at once, no progress, no build", title() === "Your parlay is ready" && progress() === -1 && rows().length > 0 && !card()?.querySelector(".animate-leg-land"));
  reduceMotion = false;

  // ---- Unmount mid-build ----
  await click("Generate parlay");
  await waitFor(() => rows().length >= 1, "a leg");
  await act(() => root.unmount());
  await wait(2500);
  check("unmount mid-build: no errors from timers left behind", errors.length === 0, errors.map(String).join(" | ").slice(0, 300));

  console.error = origError;
  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
