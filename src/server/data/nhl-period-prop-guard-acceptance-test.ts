// NHL player props scoped to a period (PR B3).
//
//   PART A  parser: a trailing "1P", a "(1P)" and no period token resolve the same player
//           (also 2P/3P, and the 1H/2H/1Q-4Q/Q1-Q4 tokens, which leaked the same way).
//   PART B  grading: an NHL prop whose period is not FULL_GAME - by the stored Period or by a legacy
//           FULL_GAME row whose text names one - stays PENDING off the full-game box score, with a
//           clear reason. A FULL_GAME prop grades exactly as before.
//
// Pure: fixtures only. Run with:  npx tsx src/server/data/nhl-period-prop-guard-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import { parseNhlPlayerProp } from "@/lib/nhl-prop";
import { parsePlayerProp } from "@/lib/bet-line";
import { parseNbaProp } from "@/lib/nba-prop";
import { resolvePlayerPropAgainstRoster } from "@/lib/player-roster-fallback";
import { extractNhlBoxScore } from "@/server/data/nhl-boxscore";
import { gradeNhlPlayerProp, type NhlPropPick } from "@/server/data/nhl-prop-grading";
import { resolvePlayerProp } from "@/server/data/grading";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}
const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8"));

async function main() {
  // ---- PART A ----
  console.log("---- PART A: trailing period token ----");
  const NHL: RosterPlayer[] = fx("nhl-league-roster-2026-10-13.json");
  for (const name of ["Fox", "Adam Fox"]) {
    const lines = [`${name} over 0.5 points 1P`, `${name} over 0.5 points (1P)`, `${name} over 0.5 points`];
    check(`parseNhlPlayerProp: ${name} - trailing 1P, (1P), none give the same name`, lines.map((l) => parseNhlPlayerProp(l)?.playerName), [name, name, name]);
    check(
      `NHL roster: ${name} - trailing 1P, (1P), none resolve the same player`,
      lines.map((l) => {
        const r = resolvePlayerPropAgainstRoster(l, NHL, undefined, "NHL");
        return r.status === "resolved" ? [r.playerName, r.team] : r.status;
      }),
      [0, 1, 2].map(() => ["Adam Fox", "New York Rangers"])
    );
  }
  check("2P / 3P trailing", [parseNhlPlayerProp("Fox over 0.5 points 2P")?.playerName, parseNhlPlayerProp("Fox over 2.5 shots on goal 3P")?.playerName], ["Fox", "Fox"]);
  check("NBA parser: trailing 1P", parseNbaProp("Fox over 0.5 points 1P")?.playerName, "Fox");
  check(
    "halves / quarters trailing (NHL + NFL parsers)",
    [parseNhlPlayerProp("Fox over 0.5 points 1H")?.playerName, parseNhlPlayerProp("Fox over 0.5 points Q2")?.playerName, parsePlayerProp("Kelce over 45.5 receiving yards 1Q")?.playerName, parsePlayerProp("Mahomes over 1.5 passing TDs 2H")?.playerName],
    ["Fox", "Fox", "Kelce", "Mahomes"]
  );
  check("a name containing the letters is untouched", parseNhlPlayerProp("Quinn Hughes over 0.5 points 1P")?.playerName, "Quinn Hughes");

  // ---- PART B ----
  console.log("---- PART B: grading guard ----");
  const box = extractNhlBoxScore(fx("nhl-boxscore-401879457-pit-buf.json"))!;
  const game = { homeTeam: "Buffalo Sabres", awayTeam: "Pittsburgh Penguins" };
  const mk = (betDetail: string, period?: string): NhlPropPick => ({ playerName: null, propMarket: null, betDetail, ...game, period });
  const deps = { fetchBox: async () => box, getRoster: async () => [] as RosterPlayer[] };
  const base = "Egor Chinakhov over 0.5 shots on goal";

  const full = await gradeNhlPlayerProp(mk(base, "FULL_GAME"), "t", deps);
  check("FULL_GAME prop still grades", full.outcome !== null, true);
  const noPeriod = await gradeNhlPlayerProp(mk(base), "t", deps);
  check("no period field grades like FULL_GAME", noPeriod, full);

  for (const period of ["FIRST_PERIOD", "SECOND_PERIOD", "THIRD_PERIOD"]) {
    const r = await gradeNhlPlayerProp(mk(base + " 1P", period), "t", deps);
    check(`stored ${period}: PENDING, reason says period stats unavailable`, [r.outcome, "reason" in r && r.reason.startsWith("period player stats unavailable")], [null, true]);
  }
  const legacy = await gradeNhlPlayerProp(mk(base + " 1P", "FULL_GAME"), "t", deps);
  check("legacy row stored FULL_GAME with '1P' in the text: PENDING", legacy.outcome, null);
  const legacyParen = await gradeNhlPlayerProp(mk(base + " (1P)", "FULL_GAME"), "t", deps);
  check("legacy row with '(1P)' in the text: PENDING", legacyParen.outcome, null);

  // Through the dispatcher the real grader and the triage page both call.
  const viaDispatch = await resolvePlayerProp({ ...mk(base + " 1P", "FIRST_PERIOD"), propMarket: null }, "t", "NHL");
  check("dispatcher: NHL 1P prop is PENDING (never reaches a box score fetch)", viaDispatch.outcome, null);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
