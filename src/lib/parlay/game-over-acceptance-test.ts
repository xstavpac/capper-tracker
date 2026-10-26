// Proof for game-over.ts and the "live games on the slip" rule: a game under way
// is LIVE (kept, priced as posted, noted); only final / postponed / cancelled
// (or a game with no feed status long past its kickoff) is over. Also the guard
// that no "game started" comparison is left outside the helper.
// Pure: no DB, no network. Run with:
//   npx tsx src/lib/parlay/game-over-acceptance-test.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hasKickedOff, isGameLive, isGameOver, LIVE_NOTE, LIVE_WINDOW_MS, OFF_BOARD_GAME_PREFIX } from "@/lib/parlay/game-over";
import type { CombinedPrice as CombinedPriceType } from "@/components/parlay/generator-result";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " - expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)));
}

const NOW = new Date("2026-10-14T23:00:00Z");
const BEFORE = "2026-10-15T00:00:00Z";
const HOUR_AGO = "2026-10-14T22:00:00Z";
const LONG_AGO = new Date(NOW.getTime() - LIVE_WINDOW_MS - 1).toISOString();

// ---- the helper ----
check("before kickoff: not kicked off, not over, not live", [hasKickedOff(BEFORE, NOW), isGameOver({ gameTime: BEFORE }, NOW), isGameLive({ gameTime: BEFORE }, NOW)], [false, false, false]);
check("at kickoff it has kicked off", hasKickedOff(NOW.toISOString(), NOW), true);
check("after kickoff, no status: live, not over", [isGameOver({ gameTime: HOUR_AGO }, NOW), isGameLive({ gameTime: HOUR_AGO }, NOW)], [false, true]);
check("feed says live: live", [isGameOver({ gameTime: HOUR_AGO, gameStatus: "live" }, NOW), isGameLive({ gameTime: HOUR_AGO, gameStatus: "live" }, NOW)], [false, true]);
check("feed says preview after kickoff (delayed start): live, not over", [isGameOver({ gameTime: HOUR_AGO, gameStatus: "preview" }, NOW), isGameLive({ gameTime: HOUR_AGO, gameStatus: "preview" }, NOW)], [false, true]);
for (const gameStatus of ["final", "postponed", "cancelled"] as const) {
  check(gameStatus + " is over, and not live", [isGameOver({ gameTime: HOUR_AGO, gameStatus }, NOW), isGameLive({ gameTime: HOUR_AGO, gameStatus }, NOW)], [true, false]);
}
check("a final game is over even with a future gameTime (a postponed game's stale slot)", isGameOver({ gameTime: BEFORE, gameStatus: "postponed" }, NOW), true);
check("no status, past the live window: over", isGameOver({ gameTime: LONG_AGO }, NOW), true);
check("unparseable or missing kickoff: over", [isGameOver({ gameTime: "" }, NOW), isGameOver({ gameTime: "TBD" }, NOW)], [true, true]);
check("a slip pick with no board game (its time is the import time): over once that has passed", isGameOver({ gameTime: HOUR_AGO, gameId: OFF_BOARD_GAME_PREFIX + "abc" }, NOW), true);
check("...and not over while that time is ahead", isGameOver({ gameTime: BEFORE, gameId: OFF_BOARD_GAME_PREFIX + "abc" }, NOW), false);

async function main() {
// ---- the Combined odds box ----
// The component uses the classic JSX runtime, so React must be global before it loads.
(globalThis as { React?: unknown }).React = React;
const { CombinedPrice } = (await import("@/components/parlay/generator-result")) as { CombinedPrice: typeof CombinedPriceType };
const html = (legs: Parameters<typeof CombinedPriceType>[0]["legs"], sameGame = false) => renderToStaticMarkup(React.createElement(CombinedPrice, { legs, sameGame }));
// The box reads the real clock, so "live" is a game that kicked off a minute ago and "pre-game" one a day ahead.
const LIVE_TIME = new Date(Date.now() - 60_000).toISOString();
const FUTURE_TIME = new Date(Date.now() + 24 * 3600_000).toISOString();
const live = (odds: number) => ({ odds, gameTime: LIVE_TIME, gameStatus: "live" as const, gameId: "g-live" });
const pre = (odds: number) => ({ odds, gameTime: FUTURE_TIME, gameId: "g-pre" });

const priced = html([live(-110), pre(+150)]);
check("a live leg with a price: the total is shown, labelled as posted", [priced.includes("Combined odds (as posted)"), priced.includes("Payout"), priced.includes("+")], [true, true, true]);
check("...with the live note", priced.includes(LIVE_NOTE), true);
const plain = html([pre(-110), pre(+150)]);
check("no live leg: no note and the plain label", [plain.includes(LIVE_NOTE), plain.includes("as posted"), plain.includes("Combined odds")], [false, false, true]);
const unpriced = html([live(0), pre(+150)]);
check("a live leg with no usable price: Unavailable, says the live leg has no price and to check FanDuel", [unpriced.includes("Unavailable"), unpriced.includes("A live leg has no price"), unpriced.includes("check FanDuel"), unpriced.includes("Payout")], [true, true, true, false]);
check("...no partial total from the other legs", unpriced.includes("+150"), false);
const unpricedPre = html([pre(0), pre(+150)]);
check("a pre-game leg with no price keeps the existing wording", [unpricedPre.includes("1 leg has no price, so this parlay can&#x27;t be priced."), unpricedPre.includes("live")], [true, false]);
const sgp = html([live(-110), live(+150)], true);
check("same-game parlay with a live leg: still priced at FanDuel, with the note", [sgp.includes("Priced at FanDuel"), sgp.includes(LIVE_NOTE)], [true, true]);
const over = html([{ odds: -110, gameTime: LIVE_TIME, gameStatus: "final" as const, gameId: "g-over" }, pre(+150)]);
check("a game that is over is not marked live", [over.includes(LIVE_NOTE), over.includes("as posted")], [false, false]);

// ---- guard: no "game started" comparison outside game-over.ts ----
// Looks for a kickoff/game time compared with the clock. Comments are skipped.
const CLOCK = String.raw`(?:now|nowMs|Date\.now\(\)|\w*[nN]ow\w*(?:\.getTime\(\))?|t)\b`;
const STRAY = [
  new RegExp(String.raw`\.getTime\(\)\s*[<>]=?\s*` + CLOCK),
  new RegExp(String.raw`\b` + CLOCK + String.raw`\s*[<>]=?\s*(?:new Date\(|Date\.parse\(|\w+\.getTime\(\))`),
  new RegExp(String.raw`\w*[nN]ow\w*\.getTime\(\)\s*[<>]=?`),
  new RegExp(String.raw`[<>]=?\s*\w*[nN]ow\w*\.getTime\(\)`),
  new RegExp(String.raw`new Date\([^)]*\)\s*[<>]=?\s*` + CLOCK),
];
function strayStartedChecks(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line, i) => ({ line: line.replace(/\/\/.*$/, ""), n: i + 1 }))
    .filter(({ line }) => STRAY.some((re) => re.test(line)))
    .map(({ line, n }) => n + ": " + line.trim());
}

check("guard self-test: it flags the comparisons the old code had", [
  strayStartedChecks("const started = (iso: string) => new Date(iso).getTime() <= nowMs;").length,
  strayStartedChecks("return !Number.isFinite(start) || start <= now.getTime();").length,
  strayStartedChecks("if (new Date(game.commenceTime).getTime() <= now.getTime()) return;").length,
  strayStartedChecks("const unstarted = (games, now) => games.filter((g) => new Date(g.gameTime).getTime() > now);").length,
  strayStartedChecks("snapshot.games.some((g) => new Date(g.gameTime).getTime() <= t)").length,
  strayStartedChecks("return start.getTime() > now.getTime() && key >= todayKey;").length,
], [1, 1, 1, 1, 1, 1]);
check("guard self-test: it leaves a snapshot-age check and comments alone", [
  strayStartedChecks("if (now.getTime() - new Date(snapshot.builtAt).getTime() > SNAPSHOT_MAX_AGE_MS) return true;").length,
  strayStartedChecks("// a game with commenceTime <= now has started").length,
], [0, 0]);

const root = join(__dirname, "..", "..", "..");
const rel = (p: string) => join(root, ...p.split("/"));
const GUARDED = [
  "src/server/actions/parlay-generate.ts",
  "src/server/actions/parlay-slip.ts",
  "src/server/data/parlay-slip-picks.ts",
  "src/server/data/fanduel-link.ts",
  "src/lib/parlay/generator.ts",
  "src/lib/parlay/generator-session.ts",
  "src/lib/parlay/auto-generate.ts",
  "src/lib/parlay/auto-generate-window.ts",
  "src/lib/parlay/slip-reconcile.ts",
  "src/lib/parlay/slip-state.ts",
  "src/lib/parlay/slip-build.ts",
  "src/lib/parlay/slip-send-legs.ts",
  "src/lib/parlay/select-checkbox-state.ts",
  "src/lib/parlay/fanduel-link.ts",
  "src/lib/parlay/leg-cap.ts",
  "src/components/live/pick-card.tsx",
  ...readdirSync(rel("src/components/parlay"))
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith("-test.ts"))
    .map((f) => "src/components/parlay/" + f),
];
for (const file of GUARDED) {
  check("no game-started comparison outside game-over.ts: " + file, strayStartedChecks(readFileSync(rel(file), "utf8")), []);
}

if (failures) {
  console.log(failures + " failure(s)");
  process.exit(1);
}
console.log("All game-over checks passed");
}
main();
