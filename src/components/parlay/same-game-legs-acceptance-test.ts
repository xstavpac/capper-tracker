// Proof of how Auto-Generate shows "max legs per game" on /parlay: the 1 / 2 /
// 3 control, what it sends, same-game legs sitting beside their game's leg with
// an "SGP" tag and the record that qualified them, the "N legs · M games · K
// SGPs" readout, the estimated price, the reworded shortfall notice, the note
// on the Hedge / Contrarian tabs, and "Send to FanDuel" saying so when a
// same-game group isn't sent whole.
//
// The real AutoGenerateSection is rendered on a jsdom document. Only the server
// action and the FanDuel request are replaced. Which legs get built is proven
// in lib/parlay/same-game-fill-acceptance-test.ts.
// Run: npx tsx src/components/parlay/same-game-legs-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { JSDOM } from "jsdom";
import type { AutoParlay, GeneratorPick, SameGameLeg, SwapLeg, SwapMode, SwapParlay } from "@/lib/parlay/auto-generate";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const FUTURE = "2099-01-01T00:00:00.000Z";
function pick(id: string, game: number, betDetail: string, odds: number): GeneratorPick {
  const home = "Home" + game;
  const away = "Away" + game;
  return {
    pickId: id, capperId: "capper-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false,
    category: "OVER", leagueName: "MLB", gameId: "game" + game, gameLabel: away + " @ " + home, betDetail,
    odds, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: betDetail, line: null,
    homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: home, teamColor: null,
    datePosted: "2098-12-31T00:00:00.000Z", oddsSource: "STATED",
  };
}

// Three games have picks. Game 1 and game 2 each have one more pick that
// qualifies and fits; s1 is also game 1's listed "next pick".
const P1 = pick("p1", 1, "Leg-P1", -110);
const P2 = pick("p2", 2, "Leg-P2", 150);
const P3 = pick("p3", 3, "Leg-P3", -120);
const S1 = pick("s1", 1, "Leg-S1", -110);
const S2 = pick("s2", 2, "Leg-S2", -110);
const sameGameLeg = (p: GeneratorPick): SameGameLeg => ({
  gameId: p.gameId, gameLabel: p.gameLabel, gameTime: p.gameTime, pick: p, record: { wins: 6, losses: 4, n: 10, winPct: 60 }, wilsonLowerBound: 0.31,
});

const calls: unknown[][] = [];
function parlayAFor(requested: number): AutoParlay {
  const legs = [P1, P2, P3].slice(0, requested).map((p) => ({
    gameId: p.gameId, gameLabel: p.gameLabel, gameTime: p.gameTime, top: { pick: p, record: null }, next: p === P1 ? [{ pick: S1, record: null }] : [],
  }));
  return { requested, available: 3, legs };
}
function swapParlay(mode: SwapMode, parlayA: AutoParlay): SwapParlay {
  const legs: SwapLeg[] = parlayA.legs.map((l) => ({ gameId: l.gameId, gameLabel: l.gameLabel, original: l.top, swap: null, unchangedReason: "NO_ALTERNATE" }));
  return { mode, legs, swapCount: 0 };
}

function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
// Leg rows offer "+ Add game", which reads the slip context; its server
// action is never called here.
stub("../../server/actions/parlay-slip", { getSlipPickStatesAction: async () => ({}) });
stub("../../server/actions/parlay-generator", {
  autoGenerateParlayAction: async (...args: unknown[]) => {
    calls.push(args);
    const [, legCount, max] = args as [string[], number, number];
    const parlayA = parlayAFor(legCount);
    const room = Math.max(0, legCount - parlayA.legs.length);
    const legs = max > 1 ? [S1, S2].slice(0, room).map(sameGameLeg) : [];
    return {
      parlayA,
      sameGame: { maxLegsPerGame: max, legs },
      hedge: swapParlay("AUTO_HEDGE", parlayA),
      contrarian: swapParlay("CONTRARIAN", parlayA),
      records: { records: {}, streaks: {}, last20: {} },
      leaguesSearched: ["MLB"],
    };
  },
});

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

  // "Send to FanDuel": p1 is found at its own line; p2 and p3 go at FanDuel's
  // nearest line (p3's is the harder one to win); s1 can't be sent.
  let fanDuelBody: { pickIds: string[] } | null = null;
  // Set for the second tap: legs with no usable status or reason at all.
  let fanDuelLegs: ((pickId: string, i: number) => unknown) | null = null;
  g.fetch = async (_url: string, init: { body: string }) => {
    fanDuelBody = JSON.parse(init.body);
    if (fanDuelLegs) return { ok: true, json: async () => ({ url: null, legs: fanDuelBody!.pickIds.map(fanDuelLegs!) }) };
    const legs = fanDuelBody!.pickIds.map((pickId) =>
      pickId === "s1"
        ? { pickId, status: "unsupported", reason: "This bet type can't be sent yet.", pickOdds: -110, fanDuelOdds: null, sentLine: null }
        : pickId === "p2"
          ? { pickId, status: "adjusted", reason: null, pickOdds: -110, fanDuelOdds: -142, sentLine: { pick: 6, fanDuel: 5.5, side: "Over", worse: false } }
          : pickId === "p3"
            ? { pickId, status: "adjusted", reason: null, pickOdds: -110, fanDuelOdds: -150, sentLine: { pick: 4.5, fanDuel: 3.5, side: "Under", worse: true } }
            : { pickId, status: "matched", reason: null, pickOdds: -110, fanDuelOdds: -110, sentLine: null }
    );
    return { ok: true, json: async () => ({ url: "https://account.sportsbook.fanduel.com/sportsbook/addToBetslip?x=1", legs }) };
  };

  const React = await import("react");
  // tsx compiles the components' JSX to React.createElement (tsconfig "jsx": "preserve"), with no import of its own.
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { AutoGenerateSection } = await import("./auto-generate-section");
  const h = React.createElement;
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(h(AutoGenerateSection, { leagues: ["MLB"] }));
    await settle();
  });
  const text = () => container.textContent ?? "";
  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const button = (starts: string) => buttons().find((b) => (b.textContent ?? "").startsWith(starts));
  const byLabel = (label: string) => buttons().find((b) => b.getAttribute("aria-label") === label);
  const maxOption = (n: number) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Max legs per game"] [role="radio"]')).find((b) => b.textContent === String(n));
  const click = (el: Element | undefined) => act(async () => {
    (el as HTMLElement | undefined)?.click();
    await settle();
  });
  const legOrder = () => (text().match(/Leg-[PS]\d/g) ?? []).filter((v, i, a) => a.indexOf(v) === i);
  const tags = () => Array.from(container.querySelectorAll("ol > li span")).filter((s) => s.textContent === "SGP").length;
  const lastCall = () => calls[calls.length - 1];

  // ---------------------------------------------------------------------
  // 1. The control, and max 1 as before
  // ---------------------------------------------------------------------
  check("control: 'Max legs per game' with 1 / 2 / 3", [1, 2, 3].every((n) => maxOption(n) !== undefined) && text().includes("Max legs per game"));
  check("control: 1 is on by default", maxOption(1)?.getAttribute("aria-checked") === "true" && maxOption(2)?.getAttribute("aria-checked") === "false");
  check("control at 1: reads one leg per game", text().includes("one per game · up to 20"));

  await click(button("Generate parlay"));
  check("max 1: the action is sent 1", JSON.stringify(lastCall()) === JSON.stringify([["MLB"], 3, 1, "ALL", null]), JSON.stringify(lastCall()));
  check("max 1: readout is the old one", text().includes("3 legs · MLB") && !text().includes("games ·"));
  check("max 1: no SGP tag, price is not an estimate", tags() === 0 && text().includes("Combined odds") && !text().includes("Est. combined odds"));
  check("max 1: game 1's next pick is still listed", text().includes("Next 1 pick in this game"));

  // 5 legs asked of 3 games at max 1: the old shortfall notice, word for word.
  await click(byLabel("More legs"));
  await click(byLabel("More legs"));
  await click(button("Generate parlay"));
  check("max 1 shortfall: 'Each game can give one leg.'", text().includes("picks from your cappers. Each game can give one leg."));
  check("max 1 shortfall: offers the 3 it has", button("Build with 3 legs") !== undefined);

  // ---------------------------------------------------------------------
  // 2. Max 2: same-game legs fill the count
  // ---------------------------------------------------------------------
  await click(maxOption(2));
  check("changing the setting clears the built result", !text().includes("Generated parlay") && button("Build with 3 legs") === undefined);
  check("control at 2: says when it applies", text().includes("up to 2 per game · up to 20") && text().includes("adds same-game legs only when there aren't enough games to reach your leg count"));
  await click(button("Generate parlay"));
  check("max 2: the action is sent 2", JSON.stringify(lastCall()) === JSON.stringify([["MLB"], 5, 2, "ALL", null]), JSON.stringify(lastCall()));
  check("filled to the count asked: shown without a shortfall prompt", text().includes("Parlay A — 5-leg parlay") && !text().includes("Build with"));
  check("readout: 5 legs · 3 games · 2 SGPs", text().includes("5 legs · 3 games · 2 SGPs"));
  check("same-game legs sit right after their game's leg", JSON.stringify(legOrder()) === JSON.stringify(["Leg-P1", "Leg-S1", "Leg-P2", "Leg-S2", "Leg-P3"]), JSON.stringify(legOrder()));
  check("SGP tag on all four legs of the two same-game groups, not on the single", tags() === 4, String(tags()));
  check("a same-game leg shows the record that qualified it: all leagues, its market", text().includes("60% (6–4) · all leagues"));
  check("says why legs were added", text().includes("Only 3 games had picks, so 2 same-game legs were added."));
  check("a pick that became a leg is not also listed as a next pick", !text().includes("Next 1 pick in this game"));
  check("price: same math, marked an estimate", text().includes("Est. combined odds≈ ") && text().includes("Estimate: sportsbooks price same-game parlays lower than independent legs."));

  await click(button("Hedge"));
  check("hedge tab: 3 legs, and says same-game legs aren't included", text().includes("Hedge — 3-leg parlay") && text().includes("Same-game legs aren't included in swap variants"));
  check("hedge tab: no same-game leg in it", !text().includes("Leg-S1") && !text().includes("Leg-S2"));
  await click(button("Contrarian"));
  check("contrarian tab: the same", text().includes("Contrarian — 3-leg parlay") && text().includes("Same-game legs aren't included in swap variants") && !text().includes("Leg-S1"));
  await click(button("Primary"));

  // ---------------------------------------------------------------------
  // 3. Send to FanDuel: a same-game group not sent whole
  // ---------------------------------------------------------------------
  await click(button("Send to FanDuel"));
  check("FanDuel is asked for all 5 legs", JSON.stringify(fanDuelBody) === JSON.stringify({ pickIds: ["p1", "s1", "p2", "s2", "p3"] }), JSON.stringify(fanDuelBody));
  check("the half-sent pair is named", text().includes("Same-game legs not fully sent") && text().includes("Away1 @ Home1: 1 of 2 legs is in the FanDuel link."));
  check("the fully-sent pair is not", !text().includes("Away2 @ Home2: "));
  check("the unsent leg still shows why", text().includes("Not supported") && text().includes("This bet type can't be sent yet."));
  check("a leg sent at FanDuel's line counts as sent", text().includes("On FanDuel · 4 of 5 legs"));
  check("it shows the line sent beside the pick's, with FanDuel's price for the line sent", text().includes("Sent as Over 5.5 · pick Over 6") && text().includes("-142pick -110"));
  const worseTags = Array.from(container.querySelectorAll("li span")).filter((el) => el.textContent === "Worse line");
  check("only the leg whose sent line is harder to win is marked 'Worse line'", worseTags.length === 1 && (worseTags[0].closest("li")?.textContent ?? "").includes("Leg-P3"), String(worseTags.length));
  check("the worse line reads out both lines and says why", text().includes("Sent as Under 3.5 · pick Under 4.5 · harder to win than your pick"));
  check("and is called out again above the Open FanDuel link", text().includes("1 leg is going at a line that is harder to win than your pick."));

  // A not-sent leg never renders an empty chip or no sentence - not for a
  // status the page doesn't know, and not for a missing or blank reason.
  const bare = [
    { status: "some_future_status", reason: null },
    { status: "not_found", reason: "" },
    { status: "error" },
    { status: "unsupported", reason: "   " },
    { status: "ambiguous", reason: null },
  ];
  fanDuelLegs = (pickId, i) => ({ pickId, pickOdds: -110, fanDuelOdds: null, sentLine: null, ...bare[i] });
  await click(button("Check FanDuel again"));
  const chips = Array.from(container.querySelectorAll("li span.bg-muted"));
  const emptyRows = chips.filter((chip) => {
    const label = (chip.textContent ?? "").trim();
    const sentence = (chip.parentElement?.textContent ?? "").trim().slice(label.length).trim();
    return label === "" || sentence === "";
  });
  check("5 legs with no usable status or reason: each still renders a labelled chip and a sentence", chips.length === 5 && emptyRows.length === 0, chips.length + " chips, " + emptyRows.length + " empty");
  check("an unknown status reads 'Not sent' and asks for a reload", text().includes("Not sent") && text().includes("reload the page and check again"));
  fanDuelLegs = null;

  // ---------------------------------------------------------------------
  // 4. Max 3, still short after same-game legs
  // ---------------------------------------------------------------------
  await click(maxOption(3));
  await click(byLabel("More legs"));
  await click(button("Generate parlay"));
  check("max 3: the action is sent 3", JSON.stringify(lastCall()) === JSON.stringify([["MLB"], 6, 3, "ALL", null]), JSON.stringify(lastCall()));
  check("still short: asks first, and says same-game legs were added", text().includes("You asked for 6 legs") && text().includes("2 same-game legs were added (up to 3 per game)"));
  check("still short: nothing shown until confirmed", !text().includes("Generated parlay"));
  await click(button("Build with 5 legs"));
  check("confirmed: the 5-leg parlay is shown", text().includes("Parlay A — 5-leg parlay") && text().includes("5 legs · 3 games · 2 SGPs"));

  await act(() => root.unmount());
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
