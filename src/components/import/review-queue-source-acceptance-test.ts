// Bot API tokens PR 6, the UI half (review-queue.tsx, lib/review-card-labels.ts). Two halves:
//   1. The pure words, in a fixed time zone: the source line for Telegram, a named token, and a revoked / deleted
//      token ("API token"); the ambiguous-team candidate labels with a stored game (home, away, side unknown, a
//      near-miss capper suffix) and without one (label unchanged); nothing time-dependent before mount.
//   2. The real queue on jsdom (actions faked): the server render has no times (no hydration mismatch), the mounted
//      card shows "<capper> · <source> · <time>" under the pick text, team buttons carry the game, other question
//      types keep their labels, and the amber panel, Dismiss, the 44px buttons and answering still work.
// Pure - no DB. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/components/import/review-queue-source-acceptance-test.ts
import { JSDOM } from "jsdom";
import type { ReviewCard, ReviewCardChoice } from "@/server/data/ingest-review-queue";
import { candidateLabel, reviewSourceLine, reviewSourceName } from "@/lib/review-card-labels";
import { teamShortName } from "@/lib/team-abbreviations";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
const eq = (label: string, actual: unknown, expected: unknown) => check(label, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

const NY = "America/New_York";
const QUEUED = "2026-11-26T07:14:00.000Z"; // 2:14 AM in New York
const KICKOFF = "2026-11-26T17:30:00.000Z"; // Thu 12:30 PM in New York
const tg = { capperName: "Godfather", source: { type: "TELEGRAM" as const }, createdAt: "2026-11-26T06:52:00.000Z" };
const namedTok = { capperName: "Five Star", source: { type: "API_TOKEN" as const, tokenName: "Telegram bot token" }, createdAt: QUEUED };
const goneTok = { capperName: "Five Star", source: { type: "API_TOKEN" as const, tokenName: null }, createdAt: QUEUED };

// ---- 1 · The words ------------------------------------------------------------------------------
eq("source names", [reviewSourceName(tg.source), reviewSourceName(namedTok.source), reviewSourceName(goneTok.source)], ["Telegram", "Telegram bot token", "API token"]);
eq(
  "source line, mounted, New York",
  [reviewSourceLine(namedTok, true, NY), reviewSourceLine(tg, true, NY), reviewSourceLine(goneTok, true, NY)],
  ["Five Star · Telegram bot token · 2:14 AM", "Godfather · Telegram · 1:52 AM", "Five Star · API token · 2:14 AM"]
);
eq("source line before mount: no time", reviewSourceLine(namedTok, false), "Five Star · Telegram bot token");
const home = { home: "DET", away: "GB", side: "HOME" as const, startsAt: KICKOFF };
const away = { home: "BOS", away: "DET", side: "AWAY" as const, startsAt: KICKOFF };
const unknownSide = { home: "DET", away: "GB", side: null, startsAt: KICKOFF };
eq(
  "candidate labels with a stored game",
  [candidateLabel("Detroit Lions (NFL)", home, true, NY), candidateLabel("Detroit Pistons (NBA)", away, true, NY), candidateLabel("Detroit Lions (NFL)", unknownSide, true, NY)],
  ["Detroit Lions (NFL) · vs GB Thu 12:30 PM", "Detroit Pistons (NBA) · at BOS Thu 12:30 PM", "Detroit Lions (NFL) · GB @ DET Thu 12:30 PM"]
);
eq("candidate label keeps a near-miss capper suffix at the end", candidateLabel("Detroit Lions (NFL) - as Five Star", home, true, NY), "Detroit Lions (NFL) · vs GB Thu 12:30 PM - as Five Star");
eq("candidate label without a stored game: unchanged", [candidateLabel("Detroit Tigers (MLB)", undefined, true, NY), candidateLabel("Detroit Tigers (MLB)", undefined, false)], ["Detroit Tigers (MLB)", "Detroit Tigers (MLB)"]);
eq("candidate label before mount: no day or time", candidateLabel("Detroit Lions (NFL)", home, false), "Detroit Lions (NFL) · vs GB");
eq(
  "short names: listed pro teams, feed spelling variants, else the full name",
  ["Green Bay Packers", "St. Louis Blues", "St Louis Blues", "Montréal Canadiens", "LA Clippers", "New York Jets", "Winnipeg Jets", "Ohio State Buckeyes"].map(teamShortName),
  ["GB", "STL", "STL", "MTL", "LAC", "NYJ", "WPG", "Ohio State Buckeyes"]
);

// ---- 2 · The queue ------------------------------------------------------------------------------
const calls: string[] = [];
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/ingest-review", {
  resolveReviewItemAction: async (id: string, choiceId: string) => {
    calls.push("resolve:" + id + ":" + choiceId);
    return { ok: true, pickLabel: "Detroit Lions ML" };
  },
  dismissReviewItemAction: async (id: string) => {
    calls.push("dismiss:" + id);
    return { ok: true };
  },
});

const choice = (c: Partial<ReviewCardChoice> & { id: string; label: string }): ReviewCardChoice => ({ playable: true, ...c });
const CARDS: ReviewCard[] = [
  {
    id: "c1",
    ...namedTok,
    lineText: "Detroit ML -110",
    day: "2026-11-26",
    questionType: "AMBIGUOUS_TEAM",
    choices: [
      choice({ id: "opt:0", label: "Detroit Lions (NFL)", game: home }),
      choice({ id: "opt:1", label: "Detroit Pistons (NBA)", game: away }),
      choice({ id: "opt:2", label: "Detroit Tigers (MLB)", playable: false, unmatched: "no MLB game today" }),
    ],
  },
  { id: "c2", ...tg, lineText: "Cubs under -110", day: "2026-11-26", questionType: "MISSING_TOTAL_LINE", choices: [choice({ id: "confirm", label: "Use the market line 8.5", inferredLine: 8.5, lineReason: "missing" })] },
  { id: "c3", ...goneTok, lineText: "Bills ML", day: "2026-11-26", questionType: "CAPPER_FUZZY", choices: [choice({ id: "use-suggestion", label: 'Use existing capper "Five Stars"', capperName: "Five Stars" })] },
];

async function main() {
  const React = await import("react");
  const g = globalThis as Record<string, unknown>;
  g.React = React;
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const router = { push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {}, forward: () => {} };
  const h = React.createElement;
  const { ReviewQueue } = await import("./review-queue");
  const tree = (cards: ReviewCard[]) => h(AppRouterContext.Provider, { value: router as never }, h(ReviewQueue, { initialCards: cards }));

  // The server render: no times anywhere, so the client's first render matches it.
  const { renderToString } = await import("react-dom/server");
  const ssr = renderToString(tree(CARDS)).replace(/<!-- -->/g, "");
  check("server render: source lines without a time", ssr.includes("Five Star · Telegram bot token<") && ssr.includes("Godfather · Telegram<") && ssr.includes("Five Star · API token<"));
  check("server render: team buttons without day/time", ssr.includes(">Detroit Lions (NFL) · vs GB<") && !/\d:\d\d [AP]M/.test(ssr));

  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/picks/import" });
  const win = dom.window;
  g.window = win;
  g.self = win;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());
  const settle = async () => {
    for (let i = 0; i < 4; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  };
  const el = win.document.createElement("div");
  win.document.body.appendChild(el);
  const root = createRoot(el);
  await act(() => root.render(tree(CARDS)));
  await settle();

  // Mounted: the viewer's own zone (this process's), the same formatter the page uses.
  const items = () => Array.from(el.querySelectorAll("li"));
  const metaOf = (li: Element) => li.children[1]?.textContent ?? "";
  eq(
    "mounted: the line under each pick text is <capper> · <source> · <local time>",
    items().map((li) => [li.children[0]?.textContent, metaOf(li)]),
    [
      ["Detroit ML -110", reviewSourceLine(namedTok, true)],
      ["Cubs under -110", reviewSourceLine(tg, true)],
      ["Bills ML", reviewSourceLine(goneTok, true)],
    ]
  );
  check("mounted: the source line ends in a time", items().every((li) => /· \d{1,2}:\d\d [AP]M$/.test(metaOf(li))));
  const buttonsOf = (li: Element) => Array.from(li.querySelectorAll("button")).map((b) => b.textContent ?? "");
  eq(
    "team card: each candidate labelled from its stored game; no game keeps its label; Dismiss stays",
    buttonsOf(items()[0]),
    [candidateLabel("Detroit Lions (NFL)", home, true), candidateLabel("Detroit Pistons (NBA)", away, true), "Detroit Tigers (MLB)", "Dismiss"]
  );
  check("team labels read '· vs GB <Day> <time>' / '· at BOS <Day> <time>'", /^Detroit Lions \(NFL\) · vs GB [A-Z][a-z]{2} \d{1,2}:\d\d [AP]M$/.test(buttonsOf(items()[0])[0]) && /· at BOS [A-Z][a-z]{2} /.test(buttonsOf(items()[0])[1]));
  eq("other question types keep their labels", [buttonsOf(items()[1]), buttonsOf(items()[2])], [["Use the market line 8.5", "Dismiss"], ['Use existing capper "Five Stars"', "Dismiss"]]);
  check("no-game candidate stays disabled with its reason", (el.querySelectorAll("li")[0].querySelectorAll("button")[2] as HTMLButtonElement).disabled && items()[0].textContent!.includes("Some answers are unavailable: no MLB game today"));
  check("every button is a 44px touch target", Array.from(el.querySelectorAll("button")).every((b) => b.className.includes("min-h-[44px]")));
  const section = el.querySelector("section")!;
  check("amber panel, light and dark", ["border-amber-400", "bg-amber-50/60", "text-amber-900", "dark:border-amber-500/60", "dark:bg-amber-500/5", "dark:text-amber-200"].every((c) => section.className.includes(c)));
  check("buttons keep the amber light/dark styles", (el.querySelector("li button") as HTMLElement).className.includes("border-amber-500") && (el.querySelector("li button") as HTMLElement).className.includes("dark:text-amber-200"));
  eq("heading count", el.querySelector("h2")?.textContent, "Needs review (3)");

  // Answering still works: a candidate resolves with its stored choice id, Dismiss dismisses.
  const click = async (b: Element | undefined) => {
    if (!b) throw new Error("no such button");
    await act(() => void b.dispatchEvent(new win.MouseEvent("click", { bubbles: true })));
    await settle();
  };
  await click(items()[0].querySelectorAll("button")[0]);
  eq("fix-and-accept: resolves the stored choice", calls, ["resolve:c1:opt:0"]);
  check("...card gone, confirmation shown, count down", el.querySelector("h2")?.textContent === "Needs review (2)" && el.textContent!.includes("Logged Detroit Lions ML for Five Star."));
  await click(Array.from(items()[0].querySelectorAll("button")).find((b) => b.textContent === "Dismiss"));
  eq("Dismiss still dismisses", calls[1], "dismiss:c2");
  eq("count follows", el.querySelector("h2")?.textContent, "Needs review (1)");
  await act(() => root.unmount());

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
