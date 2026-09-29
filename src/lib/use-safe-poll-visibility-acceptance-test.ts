// Proof that useSafePoll makes NO fetches while the tab is hidden and
// refreshes promptly when it becomes visible - the behavior the live ticker
// (which runs on every authenticated page) relies on to stop polling from
// background tabs. document.visibilityState is mocked on a jsdom document.
// Run: npx tsx src/lib/use-safe-poll-visibility-acceptance-test.ts
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

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useSafePoll } = await import("./use-safe-poll");

  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount++;
    return fetchCount;
  };

  function Probe() {
    useSafePoll<number>({ fetcher, enabled: true, intervalMs: 1000 });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => {
    root.render(React.createElement(Probe));
  });

  // Mounted while hidden: the first poll fires (~1s) but must not fetch.
  await React.act(async () => {
    await sleep(2500);
  });
  check("no fetch while the tab is hidden at mount", fetchCount === 0, `fetchCount=${fetchCount}`);

  // Becoming visible refreshes right away (well inside the 1s base interval).
  await React.act(async () => {
    setVisibility("visible");
    await sleep(500);
  });
  check("becoming visible triggers a fetch within 500ms", fetchCount === 1, `fetchCount=${fetchCount}`);

  // Keeps polling while visible.
  await React.act(async () => {
    await sleep(1500);
  });
  check("keeps polling while visible", fetchCount >= 2, `fetchCount=${fetchCount}`);

  // Hidden again: count freezes even across several intervals.
  await React.act(async () => {
    setVisibility("hidden");
    await sleep(100);
  });
  const frozenAt = fetchCount;
  await React.act(async () => {
    await sleep(3500);
  });
  check("no further fetches after the tab is hidden", fetchCount === frozenAt, `before=${frozenAt} after=${fetchCount}`);

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
