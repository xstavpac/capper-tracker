// The /live scores poll runs through useSafePoll: no request while the tab is
// hidden, an immediate refetch when it becomes visible again, scores applied
// from the response, and the same URL and cache mode as before. fetch is
// mocked and document.visibilityState driven on a jsdom document, as in
// src/lib/use-safe-poll-visibility-acceptance-test.ts (which covers the hook's
// cadence; this covers that the Live poll is wired to it).
// Run: npx tsx src/components/live/use-live-scores-acceptance-test.ts
// Exits non-zero if any assertion fails.
import { JSDOM } from "jsdom";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/" });
  const g = globalThis as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;

  let visibility: "visible" | "hidden" = "hidden";
  Object.defineProperty(dom.window.document, "visibilityState", { get: () => visibility, configurable: true });
  const setVisibility = (v: "visible" | "hidden") => {
    visibility = v;
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  };

  const calls: { url: string; cache: unknown }[] = [];
  let respondOk = true;
  g.fetch = async (url: string, init?: { cache?: string }) => {
    calls.push({ url, cache: init?.cache });
    return respondOk
      ? { ok: true, status: 200, json: async () => ({ scores: [{ id: "polled-" + calls.length }] }) }
      : { ok: false, status: 500, json: async () => ({}) };
  };

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useLiveScores, LIVE_POLL_INTERVAL_MS } = await import("./use-live-scores");

  check("poll interval is still 25 s", LIVE_POLL_INTERVAL_MS === 25000);

  let latest: { id: string }[] = [];
  const initial = [{ id: "initial" }];
  function Probe() {
    latest = useLiveScores("baseball_mlb", initial as never) as never;
    return null;
  }

  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => {
    root.render(React.createElement(Probe));
  });
  check("renders the server snapshot first", latest[0]?.id === "initial");

  // Mounted in a hidden tab: nothing is fetched, however long it stays hidden.
  await React.act(async () => {
    await sleep(2500);
  });
  check("no request while the tab is hidden", calls.length === 0, `calls=${calls.length}`);

  // Becoming visible refetches straight away (not after the 25 s interval).
  await React.act(async () => {
    setVisibility("visible");
    await sleep(500);
  });
  check("becoming visible refetches immediately", calls.length === 1, `calls=${calls.length}`);
  check(
    "same URL and no-store as before",
    calls[0]?.url === "/api/live/scores?sport=baseball_mlb" && calls[0]?.cache === "no-store",
    JSON.stringify(calls[0])
  );
  check("the polled scores replace the snapshot", latest[0]?.id === "polled-1", JSON.stringify(latest));

  // Hidden again, then shown again: paused in between, immediate refetch on return.
  await React.act(async () => {
    setVisibility("hidden");
    await sleep(100);
  });
  const frozenAt = calls.length;
  await React.act(async () => {
    await sleep(3500);
  });
  check("no requests while hidden again", calls.length === frozenAt, `before=${frozenAt} after=${calls.length}`);
  await React.act(async () => {
    setVisibility("visible");
    await sleep(500);
  });
  check("showing it again refetches immediately", calls.length === frozenAt + 1, `calls=${calls.length}`);
  check("the newer scores are applied", latest[0]?.id === "polled-" + calls.length, JSON.stringify(latest));

  // A failing response is not applied as scores.
  respondOk = false;
  const before = latest[0]?.id;
  await React.act(async () => {
    setVisibility("hidden");
    await sleep(50);
    setVisibility("visible");
    await sleep(500);
  });
  check("a non-2xx response leaves the last scores in place", latest[0]?.id === before, JSON.stringify(latest));

  await React.act(async () => {
    root.unmount();
  });

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
