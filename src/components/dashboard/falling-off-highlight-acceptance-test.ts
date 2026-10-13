// Falling off's chart (FormPanel, capper-panel.tsx): which line is highlighted, and that a legend row
// moves the highlight - the line's style, the end dot, the row tint, the footer sentence and "View
// trend" all follow it. The real component is rendered on a jsdom document.
// Run: npx tsx src/components/dashboard/falling-off-highlight-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { JSDOM } from "jsdom";
import type { FallingEntry } from "@/lib/cappers-panels";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  console.log(`${a === e ? "PASS" : "FAIL"}: ${label}${a === e ? "" : `  got ${a}, expected ${e}`}`);
  if (a !== e) failures++;
}

// 3 wins in the last 10 for every capper, in a different order each, against a different norm.
const row = (n: number, name: string, baseline: number, pct: number, wins: number[]): FallingEntry => ({
  capperId: "c" + n,
  name,
  colorTag: null,
  pct,
  pts: Math.round((0.3 - baseline) * 100),
  baseline,
  results: Array.from({ length: 10 }, (_, i) => wins.includes(i)),
});
const ROWS: FallingEntry[] = [
  row(1, "Alpha Picks", 0.71, -58, [0, 1, 2]),
  row(2, "Bravo Bets", 0.6, -50, [0, 4, 9]),
  row(3, "Charlie Locks", 0.55, -45, [2, 3, 8]),
  row(4, "Delta Plays", 0.5, -40, [1, 5, 6]),
  row(5, "Echo Edge", 0.45, -33, [7, 8, 9]),
];
const RED = "#E11D48";
const OWN = ["#64748B", "#2563EB", "#D97706", "#7C3AED", "#0891B2"];

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/dashboard" });
  const win = dom.window;
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.self = win;
  g.document = win.document;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const React = await import("react");
  // tsx compiles the components' JSX to React.createElement (tsconfig "jsx": "preserve"), with no import of its own.
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { FormPanel } = await import("./capper-panel");
  const h = React.createElement;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const router = { push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {}, forward: () => {} };

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const render = (rows: FallingEntry[]) =>
    React.act(async () => {
      root.render(h(AppRouterContext.Provider, { value: router as never }, h(FormPanel, { panel: "falling", rows })));
      await tick();
    });
  const click = (el: Element | undefined) =>
    React.act(async () => {
      (el as HTMLElement | undefined)?.click();
      await tick();
    });

  const lines = () => Array.from(container.querySelectorAll("polyline[data-series]"));
  const style = (id: string) => {
    const l = container.querySelector(`polyline[data-series="${id}"]`);
    return [l?.getAttribute("stroke"), l?.getAttribute("stroke-width"), l?.getAttribute("stroke-opacity")];
  };
  const buttons = () => Array.from(container.querySelectorAll("ol button"));
  const pressed = () => buttons().map((b) => b.getAttribute("aria-pressed"));
  const tinted = () => buttons().map((b) => b.className.includes("bg-[#FFE1E9]"));
  const swatches = () => buttons().map((b) => (b.firstElementChild as HTMLElement).style.backgroundColor);
  const rgb = (hex: string) => "rgb(" + [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ") + ")";
  const footer = () => container.querySelector("section > div:last-child");
  const footerName = () => footer()?.querySelector("p span")?.textContent;
  const footerText = () => footer()?.querySelector("p")?.textContent;
  const trendHref = () => footer()?.querySelector("a")?.getAttribute("href");
  const endDot = () => container.querySelector("[data-end-dot]");

  await render(ROWS);

  console.log("########## 1. Default: #1 (the biggest drop) is highlighted ##########");
  expect("one line per capper", lines().length, 5);
  expect("#1's line: panel red, 3px, opaque", style("c1"), [RED, "3", "1"]);
  expect(
    "the others: their own color, 1.75px, 80% opacity",
    ["c2", "c3", "c4", "c5"].map(style),
    [1, 2, 3, 4].map((i) => [OWN[i], "1.75", "0.8"])
  );
  expect("the highlighted line is drawn last (on top)", lines().at(-1)?.getAttribute("data-series"), "c1");
  expect("a solid end dot on the highlighted line", [endDot()?.getAttribute("data-end-dot"), (endDot() as HTMLElement).style.backgroundColor, container.querySelectorAll("[data-end-dot]").length], ["c1", rgb(RED), 1]);
  expect("legend rows are buttons, one per capper, in rank order", buttons().map((b) => [b.tagName, b.getAttribute("type"), b.children[1].textContent]), ROWS.map((r) => ["BUTTON", "button", r.name]));
  expect("no legend row is a link any more", container.querySelectorAll("ol a").length, 0);
  expect("#1's row is pressed and tinted", [pressed(), tinted()], [["true", "false", "false", "false", "false"], [true, false, false, false, false]]);
  expect("legend swatches match the lines", swatches(), [RED, OWN[1], OWN[2], OWN[3], OWN[4]].map(rgb));
  expect("a row keeps the relative drop and the two win rates", buttons()[0].children[2].textContent, "−58%71% → 30%");
  expect("the hint is under the legend", container.querySelector("ol + p")?.textContent, "Tap a capper to highlight their line");
  expect("no floating badge: the drop is only in the legend", Array.from(container.querySelectorAll("span")).filter((s) => s.textContent === "−58%" && !s.closest("button")).length, 0);
  expect("footer names #1", [footerName(), footerText(), trendHref()], ["Alpha Picks", "Alpha Picks is down 58% from their normal 71%", "/cappers/c1"]);

  console.log("\n########## 2. Clicking a legend row moves the highlight ##########");
  await click(buttons()[2]);
  expect("the clicked capper's line takes the highlight style", style("c3"), [RED, "3", "1"]);
  expect("#1's line drops to its own color", style("c1"), [OWN[0], "1.75", "0.8"]);
  expect("the rest are unchanged", ["c2", "c4", "c5"].map(style), [1, 3, 4].map((i) => [OWN[i], "1.75", "0.8"]));
  expect("exactly one line is highlighted", lines().filter((l) => l.getAttribute("stroke-width") === "3").length, 1);
  expect("it is drawn on top", lines().at(-1)?.getAttribute("data-series"), "c3");
  expect("the end dot moves to it", [endDot()?.getAttribute("data-end-dot"), container.querySelectorAll("[data-end-dot]").length], ["c3", 1]);
  expect("the row tint moves with it", [pressed(), tinted()], [["false", "false", "true", "false", "false"], [false, false, true, false, false]]);
  expect("the swatches follow", swatches(), [OWN[0], OWN[1], RED, OWN[3], OWN[4]].map(rgb));
  expect("the footer names the highlighted capper", [footerName(), footerText(), trendHref()], ["Charlie Locks", "Charlie Locks is down 45% from their normal 55%", "/cappers/c3"]);

  console.log("\n########## 3. A new render without the picked capper falls back to #1 ##########");
  await render(ROWS.filter((r) => r.capperId !== "c3"));
  expect("#1 is highlighted again", [style("c1"), pressed(), footerName(), trendHref()], [[RED, "3", "1"], ["true", "false", "false", "false"], "Alpha Picks", "/cappers/c1"]);

  await React.act(async () => root.unmount());
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
