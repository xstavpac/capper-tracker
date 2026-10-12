// Proof that every built parlay shows its combined price: Auto-Generate's
// Primary, Hedge and Contrarian tabs, and My Picks' own result plus its Auto
// Hedge / Contrarian. Each one is priced from the legs it actually plays (a
// swapped leg's price, not the pick it replaced), says "estimate" when a leg
// is priced at the DEFAULTED -110 placeholder, and says "unavailable" - with
// no number - when a leg has no price.
//
// The real AutoGenerateSection, ParlayPoolProvider and ParlayPoolSection are
// rendered on a jsdom document. Only the server actions are replaced. The
// math itself is proven in lib/parlay/combine-odds-acceptance-test.ts.
// Run: npx tsx src/components/parlay/combined-price-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { JSDOM } from "jsdom";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { PickOddsSource } from "@/lib/odds-source";
import type { AutoParlay, GeneratorPick, SwapLeg, SwapMode, SwapParlay } from "@/lib/parlay/auto-generate";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const FUTURE = "2099-01-01T00:00:00.000Z";
function pick(id: string, game: number, odds: number, oddsSource: PickOddsSource | null): GeneratorPick {
  const home = "Home" + game;
  const away = "Away" + game;
  return {
    pickId: id, capperId: "capper-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false,
    category: null, leagueName: "MLB", gameId: "game" + game, gameLabel: away + " @ " + home, betDetail: home + " ML",
    odds, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: home + " ML", line: null,
    homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: home, teamColor: null,
    datePosted: "2098-12-31T00:00:00.000Z", oddsSource,
  };
}

// The primary: -110 (21/11) x +150 (2.5) x -120 (11/6) = 8.75 -> +775. Its
// third leg is a placeholder price, so the primary is an estimate.
const P1 = pick("p1", 1, -110, "STATED");
const P2 = pick("p2", 2, 150, "MARKET");
const P3 = pick("p3", 3, -120, "DEFAULTED");
// Hedge swaps the placeholder leg for a stated +200: 21/11 x 2.5 x 3 =
// 14.3181... -> +1,332, and no longer an estimate.
const H3 = pick("h3", 3, 200, "STATED");
// Contrarian swaps leg 1 for a pick stored with odds 0: no price at all.
const C1 = pick("c1", 1, 0, null);

const parlayA: AutoParlay = {
  requested: 3,
  available: 3,
  legs: [P1, P2, P3].map((p) => ({ gameId: p.gameId, gameLabel: p.gameLabel, gameTime: p.gameTime, top: { pick: p, record: null }, next: [] })),
};
function swapParlay(mode: SwapMode, swaps: Record<string, GeneratorPick>): SwapParlay {
  const legs: SwapLeg[] = [P1, P2, P3].map((p) => {
    const to = swaps[p.pickId];
    return {
      gameId: p.gameId,
      gameLabel: p.gameLabel,
      original: { pick: p, record: null },
      swap: to ? { pick: to, rule: "R" as never, record: { wins: 6, losses: 4, n: 10, winPct: 60 }, wilsonLowerBound: 0.3 } : null,
      unchangedReason: to ? null : "NO_ALTERNATE",
    };
  });
  return { mode, legs, swapCount: legs.filter((l) => l.swap).length };
}
const HEDGE = swapParlay("AUTO_HEDGE", { p3: H3 });
const CONTRARIAN = swapParlay("CONTRARIAN", { p1: C1 });
const EMPTY_RECORDS = { records: {}, streaks: {}, last20: {} };

function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-generator", {
  autoGenerateParlayAction: async () => ({ parlayA, hedge: HEDGE, contrarian: CONTRARIAN, records: EMPTY_RECORDS, leaguesSearched: ["MLB"] }),
});
const SLIP: ExpanderPick[] = [P1, P2, P3];
stub("../../server/actions/parlay-slip", {
  getSlipPickStatesAction: async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { status: "PENDING", odds: SLIP.find((p) => p.pickId === id)!.odds, kickoff: FUTURE, started: false }])),
});
stub("../../server/actions/picks", { getLeagueRecordsAction: async () => EMPTY_RECORDS });
stub("../../server/actions/parlay-pool-generator", {
  generatePoolSwapAction: async (_ids: string[], _legCount: number, mode: SwapMode) => ({
    parlayA,
    swap: mode === "AUTO_HEDGE" ? HEDGE : CONTRARIAN,
    skipped: [],
    unverified: [],
    requested: 3,
    shortfall: 0,
    records: EMPTY_RECORDS,
    leaguesSearched: ["MLB"],
  }),
});

const PRIMARY_PRICE = "Combined odds (estimate)≈ +775Decimal≈ 8.75Payout≈ $8.75on $1";
const PRIMARY_NOTE = "Estimate: 1 of 3 legs had no posted price and is counted at a placeholder -110.";
const HEDGE_PRICE = "Combined odds+1,332Decimal14.32Payout$14.32on $1";
const UNAVAILABLE = "Combined oddsUnavailable1 leg has no price, so this parlay can't be priced.";

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/parlay" });
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
  const { AutoGenerateSection } = await import("./auto-generate-section");
  const { ParlayPoolProvider } = await import("./parlay-pool-context");
  const { ParlayPoolSection } = await import("./parlay-pool-section");
  const h = React.createElement;
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());

  function mount(node: React.ReactNode) {
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container);
    const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    return {
      root,
      render: () => act(async () => {
        root.render(node);
        await settle();
      }),
      text: () => container.textContent ?? "",
      button: (starts: string) => buttons().find((b) => (b.textContent ?? "").startsWith(starts)),
      // The text of the result block under the heading that starts with `title`.
      block: (title: string) => Array.from(container.querySelectorAll("h3")).find((el) => (el.textContent ?? "").startsWith(title))?.parentElement?.textContent ?? "",
    };
  }
  const click = (el: Element | undefined) => act(async () => {
    (el as HTMLElement | undefined)?.click();
    await settle();
  });
  const noBadNumber = (s: string) => !/Infinity|NaN/.test(s);

  // ---------------------------------------------------------------------
  // 1. Auto-Generate: Primary / Hedge / Contrarian tabs
  // ---------------------------------------------------------------------
  const auto = mount(h(AutoGenerateSection, { leagues: ["MLB"] }));
  await auto.render();
  check("auto: no price before anything is built", !auto.text().includes("Combined odds"));
  await click(auto.button("Generate parlay"));
  check("auto primary: combined American, decimal and payout on $1 are shown", auto.block("Parlay A").includes(PRIMARY_PRICE), auto.block("Parlay A").slice(0, 200));
  check("auto primary: a DEFAULTED leg makes it an estimate, and says how many legs", auto.block("Parlay A").includes(PRIMARY_NOTE));

  await click(auto.button("Hedge"));
  check("auto hedge: priced from the swapped leg, not the pick it replaced", auto.block("Hedge").includes(HEDGE_PRICE), auto.block("Hedge").slice(0, 200));
  check("auto hedge: with the placeholder leg swapped out it is not an estimate", !auto.block("Hedge").includes("stimate") && !auto.block("Hedge").includes("≈"));

  await click(auto.button("Contrarian"));
  check("auto contrarian: a leg with odds 0 makes the price unavailable", auto.block("Contrarian").includes(UNAVAILABLE), auto.block("Contrarian").slice(0, 200));
  check("auto contrarian: no number is shown in its place", !/Decimal|Payout|on \$1/.test(auto.block("Contrarian")) && noBadNumber(auto.block("Contrarian")));
  await act(() => auto.root.unmount());

  // ---------------------------------------------------------------------
  // 2. My Picks, and its Auto Hedge / Contrarian
  // ---------------------------------------------------------------------
  win.localStorage.setItem("parlay-pool:user-1", JSON.stringify({ pool: SLIP, leagueScope: { MLB: true }, legCount: 3 }));
  const mine = mount(h(ParlayPoolProvider, { userId: "user-1", children: null }, h(ParlayPoolSection)));
  await mine.render();
  check("my picks: no price on the slip itself, only on a built parlay", mine.text().includes("Capper p1") && !mine.text().includes("Combined odds"));

  await click(mine.button("My Picks"));
  check("my picks: combined American, decimal and payout on $1 are shown", mine.block("My Picks").includes(PRIMARY_PRICE), mine.block("My Picks").slice(0, 200));
  check("my picks: a slip leg's price source survives the slip's DB re-check", mine.block("My Picks").includes(PRIMARY_NOTE));

  await click(mine.button("Auto Hedge"));
  check("my picks auto hedge: priced from the legs it plays", mine.block("Hedge").includes(HEDGE_PRICE), mine.block("Hedge").slice(0, 200));
  await click(mine.button("Contrarian"));
  check("my picks contrarian: unavailable when a leg has no price", mine.block("Contrarian").includes(UNAVAILABLE), mine.block("Contrarian").slice(0, 200));
  check("my picks: all three results are priced at once, none with Infinity or NaN", (mine.text().match(/Combined odds/g) ?? []).length === 3 && noBadNumber(mine.text()));
  await act(() => mine.root.unmount());

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
