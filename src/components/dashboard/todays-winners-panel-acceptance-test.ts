// Proof of what the /dashboard Today's Winners card shows and when it fetches. The real
// TodaysWinnersPanel is rendered on a jsdom document; only fetch is replaced, answering as
// GET /api/cappers/panel does. The SQL behind the rows (ranking by units, pending left out, the
// Eastern-midnight boundary) is proved in src/server/data/cappers-page-aggregates-acceptance-test.ts.
// Run: npx tsx src/components/dashboard/todays-winners-panel-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { JSDOM } from "jsdom";
import type { WinnerEntry } from "@/lib/cappers-panels";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The card's first fetch is a second after mount (useSafePoll).
const FIRST_FETCH_MS = 1400;

const row = (name: string, netUnits: number, wins: number, losses: number, pushes = 0): WinnerEntry => ({ capperId: "c-" + name, name, colorTag: null, netUnits, wins, losses, pushes });

async function main() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/" });
  const g = globalThis as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  // next/link schedules its prefetch check on `self`.
  g.self = dom.window;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;

  let visibility: "visible" | "hidden" = "visible";
  Object.defineProperty(dom.window.document, "visibilityState", { get: () => visibility, configurable: true });

  const urls: string[] = [];
  let respond: () => { status: number; body: unknown } = () => ({ status: 200, body: { rows: [] } });
  g.fetch = async (url: string) => {
    urls.push(String(url));
    const { status, body } = respond();
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };

  const React = await import("react");
  // tsx compiles the components' JSX to React.createElement, which reads a global.
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { TodaysWinnersPanel } = await import("./todays-winners-panel");
  const { TODAYS_WINNERS_REFRESH_MS } = await import("@/lib/cappers-panels");

  const host = dom.window.document.getElementById("root")!;
  // Mounts the card, waits `ms`, hands back its text, and unmounts.
  async function shown(ms = FIRST_FETCH_MS, during?: () => Promise<void>): Promise<string> {
    const root = createRoot(host);
    await React.act(async () => {
      root.render(React.createElement(TodaysWinnersPanel, { leaderboardHref: "/cappers#leaderboard" }));
    });
    await React.act(async () => {
      await sleep(ms);
      await during?.();
    });
    const text = host.textContent ?? "";
    await React.act(async () => {
      root.unmount();
    });
    return text;
  }

  check("refresh interval is no shorter than 2 minutes", TODAYS_WINNERS_REFRESH_MS >= 120_000, String(TODAYS_WINNERS_REFRESH_MS));

  // ---- Empty states ----
  respond = () => ({ status: 200, body: { rows: [], graded: false } });
  const none = await shown();
  check('nothing graded today -> "No graded picks yet today."', none.includes("No graded picks yet today."), none);
  check("the empty card has no rows and no footer", !none.includes("View all") && !none.includes("Record"), none);
  check("it reads Biggest Winners at Today, once", urls.length === 1 && urls[0] === "/api/cappers/panel?panel=winners&window=today", urls.join(" | "));

  respond = () => ({ status: 200, body: { rows: [], graded: true } });
  const noneUp = await shown();
  check("graded picks but nobody ahead -> says so, not that nothing is graded", noneUp.includes("No cappers in the green today.") && !noneUp.includes("No graded picks yet today."), noneUp);

  // ---- Rows: the route's order (net units, best first) is the order shown ----
  respond = () => ({ status: 200, body: { rows: [row("Big", 3, 1, 0), row("Mixed", 1.5, 2, 1, 1), row("Small", 0.5, 1, 0)] } });
  const rows = await shown();
  const at = (s: string) => rows.indexOf(s);
  check("cappers are listed in the order ranked (by units)", at("Big") >= 0 && at("Big") < at("Mixed") && at("Mixed") < at("Small"), rows);
  check("a row shows W-L, win % and units", rows.includes("1–0") && rows.includes("100%") && rows.includes("+3.0u"), rows);
  check("pushes are in the record when there are any (2–1–1), and win % is of decided picks (67%)", rows.includes("2–1–1") && rows.includes("67%") && rows.includes("+1.5u"), rows);
  check("no push count on a record without one", !rows.includes("1–0–0"), rows);
  check("the footer totals the listed profit and links on", rows.includes("total profit from the top 3") && rows.includes("View all"), rows);

  // ---- A failed first load says so ----
  respond = () => ({ status: 500, body: {} });
  const failed = await shown();
  check("a failed load shows an error, not an empty day", failed.includes("Couldn't load today's winners.") && !failed.includes("No graded picks yet today."), failed);

  // ---- Hidden tab: no fetch until it is shown ----
  respond = () => ({ status: 200, body: { rows: [row("Late", 2, 2, 0)] } });
  visibility = "hidden";
  urls.length = 0;
  let whileHidden = -1;
  const resumed = await shown(FIRST_FETCH_MS, async () => {
    whileHidden = urls.length;
    visibility = "visible";
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await sleep(500);
  });
  check("no fetch while the tab is hidden", whileHidden === 0, String(whileHidden));
  check("it fetches when the tab is shown again", urls.length === 1 && resumed.includes("Late"), urls.length + " " + resumed);

  if (failures > 0) {
    console.log(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
