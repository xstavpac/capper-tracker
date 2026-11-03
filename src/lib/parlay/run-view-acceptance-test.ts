// The admin Generator tab (components/admin/generator-runs.tsx, lib/parlay/run-view.ts): what a stored run
// (parlay_generator_runs) shows. Pinned: the funnel rows with their drops and reasons in stage order, red for
// a stage that collapsed to 0, amber for a count of exactly 50 / 100 / 1000 (in the funnel and in the
// snapshot intake), errors and Hybrid's ladder status on the page, the per-pick detail grouped by stage and
// reason on a run's own page, the plain-text report with no ids or emails, and the tab registered before
// Imports. The rows are what the recorder stores, built here from real traces. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/run-view-acceptance-test.ts
import * as React from "react";
import type * as GeneratorRuns from "@/components/admin/generator-runs";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_TABS } from "@/lib/admin-tabs";
import { formatAdminReport } from "@/lib/admin-report";
import { funnelsOf, reasonBreakdown, runFlags, runsReport, settingsLine, suspectIntake, type RunRow } from "@/lib/parlay/run-view";
import { REASON_CODES, REASON_LABELS, reconcileTrace, STAGE_CHAINS, TraceCollector, type RunTrace } from "@/lib/parlay/run-trace";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}
const ok = (label: string, cond: boolean) => check(label, cond, true);

// A run as the recorder would store it, from a real collector: 100 pending picks, every one dropped before
// the gate (so the funnel collapses to 0), the intake read exactly 1000 pick rows.
function standardRun(): RunRow & { detail: RunTrace["detail"] } {
  const c = new TraceCollector({ mode: "STANDARD", trigger: "FETCH", origin: "SERVER", scoringVersion: "standard/LEAGUE_FIRST/z1.5/no-headcount/prop-market-records", settings: { legCount: 3, maxLegsPerGame: 1, include: ["PROPS"], minWinPct: 55, leagues: ["NBA"], targets: 0, slipPicks: 0 } }, true);
  c.stage("POOL", 100);
  c.stage("IN_SCOPE_GAMES", 100);
  c.stage("NOT_SLIP", 100);
  c.stage("INCLUDED", 40);
  for (let i = 0; i < 60; i++) c.drop("INCLUDED", "FILTER_BET_TYPE", { id: "pick" + i, label: "Capper A — Over 8.5" }, "TOTALS");
  c.stage("HAS_RECORD", 0);
  for (let i = 0; i < 40; i++) c.drop("HAS_RECORD", i < 30 ? "NO_PROP_MARKET_RECORD" : "NO_CATEGORY", { id: "prop" + i, label: "Capper B — LeBron Over 25.5 Points" }, "BASKETBALL:POINTS");
  c.stage("PASSES_GATE", 0);
  c.stage("NO_SLIP_CONFLICT", 0);
  c.stage("SELECTED", 0);
  c.error("LADDER_ERROR", "api-failure", "Lakers @ Celtics");
  c.extras({
    snapshot: { leagues: [{ league: "NBA", boardGames: 9, pickRowsFetched: 1000, pickRowsMatched: 100, pickRowsUnmatched: 900, matchedPending: 100, gamesWithPending: 9, gamesKept: 9 }], poolPicks: 100, games: [["NBA", "Lakers @ Celtics", 12, 12, "kept"], ["NBA", "Suns @ Jazz", 3, 3, "started"]] },
    ladders: [
      { eventId: "e1", gameLabel: "Lakers @ Celtics", markets: ["alternate_spreads", "alternate_totals"], status: "ok" },
      { eventId: "e2", gameLabel: "Suns @ Jazz", markets: ["alternate_totals"], status: "unavailable", cause: "budget" },
    ],
    swaps: [
      {
        mode: "CONTRARIAN",
        scope: "ALL",
        swapCount: 0,
        legs: [{ pick: { id: "l1", label: "Capper C — Bulls ML" }, result: "NO_ALTERNATE", gamePicks: 4, excluded: { FILTER_BET_TYPE: 0, IN_SLIP: 1, ALREADY_IN_PARLAY: 0, SAME_GAME_CONFLICT: 0 }, classifier: { R2: 1, R4: 2 }, paired: 1, noRecord: 1, belowGate: 0, qualified: 0 }],
      },
    ],
    notes: ["variety:BEST"],
  });
  const t = c.finish();
  return {
    id: "cmabcdefghijklmnopqrstuvw1",
    createdAt: new Date("2026-11-02T18:30:00.000Z"),
    mode: t.mode,
    trigger: t.trigger,
    origin: t.origin,
    scoringVersion: t.scoringVersion,
    settings: t.settings,
    stages: t.stages,
    reasons: t.reasons,
    errors: t.errors,
    extras: t.extras as RunRow["extras"],
    detailTruncated: t.detailTruncated,
    traceFailed: t.failed,
    durationMs: 41,
    detail: t.detail,
  };
}

async function main() {
// The components use the classic JSX runtime, so React must be global before they load.
(globalThis as { React?: unknown }).React = React;
const { RunDetailView, RunsList } = (await import("@/components/admin/generator-runs")) as typeof GeneratorRuns;
const run = standardRun();
check("the trace reconciles", reconcileTrace(run), []);

// ---- the funnel ----
const [pool] = funnelsOf(run);
check("the funnel is one chain, stages in order", [pool.chain, pool.rows.map((r) => r.stage)], ["pool", ["POOL", "IN_SCOPE_GAMES", "NOT_SLIP", "INCLUDED", "HAS_RECORD", "PASSES_GATE", "NO_SLIP_CONFLICT", "SELECTED"]]);
const row = (s: string) => pool.rows.find((r) => r.stage === s)!;
check("a stage shows what it was before", [row("INCLUDED").previous, row("INCLUDED").count], [100, 40]);
check("a stage lists its reasons, biggest first", row("HAS_RECORD").reasons.map((r) => [r.reason, r.count, r.sub]), [["NO_PROP_MARKET_RECORD", 30, "BASKETBALL:POINTS"], ["NO_CATEGORY", 10, "BASKETBALL:POINTS"]].map((r) => r));
check("a stage that fell to 0 from something is flagged", [row("HAS_RECORD").flags, row("PASSES_GATE").flags], [["COLLAPSE"], []]);
check("a count of exactly 100 is flagged, 40 is not", [row("POOL").flags, row("INCLUDED").flags], [["SUSPECT_COUNT"], []]);
check("a stage that was already 0 is not a new collapse", row("SELECTED").flags, []);
check("the intake at exactly 1000 pick rows is flagged", suspectIntake(run), ["NBA: 1000 pick rows read", "NBA: 100 picks matched to a game", "100 pending picks in the pool"]);
check("the run's flags", runFlags(run), { collapses: 1, suspect: 6, errors: 1 });
check("reason breakdown totals", reasonBreakdown(run).map((r) => [r.reason, r.count]), [["FILTER_BET_TYPE", 60], ["NO_PROP_MARKET_RECORD", 30], ["NO_CATEGORY", 10]]);
ok("every reason code has a label", REASON_CODES.every((r) => REASON_LABELS[r].length > 0));
ok("every funnel stage has a label (a stage with none would show its key)", Object.values(STAGE_CHAINS).flat().every((s) => funnelsOf({ stages: [{ key: s, count: 1 }], reasons: [] })[0].rows[0].label !== s));
check("settings read as a line", settingsLine(run.settings), "3 legs · 1/game · bets: PROPS · gate 55% · NBA");

// ---- the page ----
const html = renderToStaticMarkup(React.createElement(RunsList, { runs: [run] }));
ok("the page shows the run's mode, time and trigger", html.includes("Standard") && html.includes("2026-11-02 18:30 UTC") && html.includes("fetch"));
ok("a collapse is called out", html.includes("collapsed to 0"));
ok("a suspect count is called out", html.includes("exactly 100"));
ok("the intake warning names the league and the count", html.includes("NBA: 1000 pick rows read"));
ok("reasons read as words with their drop counts", html.includes("−30 Capper has no record in this prop market") && html.includes("−60 Bet Types filter"));
ok("the error is shown with its code and where", html.includes("LADDER_ERROR") && html.includes("Lakers @ Celtics"));
ok("the ladder status shows the cause", html.includes("unavailable (budget)"));
ok("the intake table is there", html.includes("Pick rows read") && html.includes("900"));
const recent = renderToStaticMarkup(React.createElement(RunsList, { runs: [{ ...run, createdAt: new Date(Date.now() - 3600_000) }] }));
const old = renderToStaticMarkup(React.createElement(RunsList, { runs: [{ ...run, createdAt: new Date(Date.now() - 60 * 86400_000) }] }));
ok("a recent Generate links to its per-pick detail", recent.includes("/admin/generator?run=cmabcdefghijklmnopqrstuvw1"));
ok("a run past the detail retention does not", !old.includes("per-pick detail"));
const regen = renderToStaticMarkup(React.createElement(RunsList, { runs: [{ ...run, trigger: "REGENERATE" }] }));
ok("a Regenerate has no per-pick detail link", !regen.includes("per-pick detail"));
check("no runs says so", renderToStaticMarkup(React.createElement(RunsList, { runs: [] })).includes("No runs yet"), true);

// ---- one run in full ----
const full = renderToStaticMarkup(React.createElement(RunDetailView, { run }));
ok("detail groups dropped picks by reason and stage", full.includes("Bet Types filter") && full.includes("HAS_RECORD") && full.includes("NO_PROP_MARKET_RECORD") === false);
ok("detail lists the pick behind a drop", full.includes("LeBron Over 25.5 Points") && full.includes("BASKETBALL:POINTS"));
ok("Contrarian is shown leg by leg: the leg, why none, the classifier verdicts", full.includes("Bulls ML") && full.includes("No alternate qualified") && full.includes("R2×1") && full.includes("R4×2") && full.includes("1 in your slip"));
ok("...with the paired / no record / below gate / qualified tally", full.includes("1 paired · 1 no record · 0 below gate · 0 qualified"));
ok("the game list shows why a game was left out", full.includes("Suns @ Jazz") && full.includes("started"));
const noDetail = renderToStaticMarkup(React.createElement(RunDetailView, { run: { ...run, detail: null, trigger: "REGENERATE" } }));
ok("a run with no detail says why", noDetail.includes("No per-pick detail"));
const capped = renderToStaticMarkup(React.createElement(RunDetailView, { run: { ...run, detailTruncated: true } }));
ok("a capped list says so", capped.includes("Detail was capped"));

// ---- Hybrid ----
const hybrid: RunRow = {
  ...run,
  id: "cmabcdefghijklmnopqrstuvw2",
  mode: "HYBRID",
  settings: { maxLegs: 25, boxLegs: "2", leagues: ["NFL"], targets: 0 },
  stages: [{ key: "HYB_GAMES_WITH_PICKS", count: 14 }, { key: "HYB_GAMES_KEPT", count: 1 }],
  reasons: [{ stage: "HYB_GAMES_KEPT", reason: "LADDER_UNAVAILABLE", sub: "alt-lines-not-posted", count: 9 }, { stage: "HYB_GAMES_KEPT", reason: "BEYOND_LADDER_LIMIT", count: 4 }],
  errors: null,
  traceFailed: false,
};
const hf = funnelsOf(hybrid);
check("Hybrid has its own chain: games, not picks", [hf.length, hf[0].chain, hf[0].rows.map((r) => r.count)], [1, "hybrid", [14, 1]]);
check("Hybrid drops are in the shared vocabulary", hf[0].rows[1].reasons.map((r) => [r.reason, r.sub, r.count]), [["LADDER_UNAVAILABLE", "alt-lines-not-posted", 9], ["BEYOND_LADDER_LIMIT", undefined, 4]]);
const hybridHtml = renderToStaticMarkup(React.createElement(RunsList, { runs: [hybrid] }));
ok("Hybrid renders its drops with their cause", hybridHtml.includes("−9 FanDuel lines not available") && hybridHtml.includes("(alt-lines-not-posted)") && hybridHtml.includes("−4 Past the pricing limit"));

// ---- the report ----
const text = formatAdminReport(runsReport([run, hybrid]));
ok("report: stage chain, drops with reasons, errors, ladders and intake", text.includes("POOL 100 > IN_SCOPE_GAMES 100") && text.includes("dropped at HAS_RECORD: NO_PROP_MARKET_RECORD [BASKETBALL:POINTS] x30") && text.includes("LADDER_ERROR (Lakers @ Celtics): api-failure") && text.includes("ladder Suns @ Jazz: unavailable (budget)") && text.includes("intake NBA: 9 board games, 1000 pick rows read"));
ok("report: flags the collapse and the suspect counts", text.includes("1 stage collapsed to 0") && text.includes("counts of exactly 50 / 100 / 1000"));
ok("report: no run id, user id or email", !text.includes("cmabcdefghijklmnopqrstuvw1") && !/@\w+\.\w+/.test(text.replace(/Lakers @ Celtics|Suns @ Jazz/g, "")));
check("an empty report says so", formatAdminReport(runsReport([])).includes("No runs yet."), true);

// ---- the tab ----
const keys = ADMIN_TABS.map((t) => t.key);
check("the Generator tab is registered, with its page's href, before Imports", [ADMIN_TABS.find((t) => t.key === "generator")?.href, keys.indexOf("generator") < keys.indexOf("imports"), keys.at(-1)], ["/admin/generator", true, "recipients"]);

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
