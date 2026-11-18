// Player props written "<player> over/under N <market>" that used to import as GAME TOTALS:
//   - NHL "Anton Lundell over 0.5 goals": the NHL parser had no goals-line market, so the line fell
//     through to a TOTAL (prod: 3 such lines sat unresolved in import_skipped_lines on 2026-11-18).
//   - MLB "Aaron Judge over 1.5 total hits": the "total" between the number and the stat word broke
//     the MLB parser (only "total bases", whose name contains the word, worked).
// Guards: game totals ("Over 6.5", "Over 6.5 total"), team totals ("Panthers over 3.5 goals",
// "Yankees over 8.5 total runs"), matchup totals and MLB "total bases" read exactly as before. The NHL
// team guard is classifyTeamSide - the team / city / alias data game matching uses.
//
// Pure: no DB, no network. Run with:
//   npx tsx src/lib/player-prop-bare-market-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import { parseCatalog, parsePickText, detectUnsupportedPropLine, normalizeNhlPlayerGoalsLine } from "@/lib/parse-catalog";
import { UNSUPPORTED_PROP_REASONS } from "@/lib/unsupported-prop-vocab";
import { parseAnyPlayerProp, parsePlayerPropLine } from "@/lib/bet-line";
import { parseNhlPlayerProp, nhlAnytimeGoalSide } from "@/lib/nhl-prop";
import { parseMlbPlayerProp } from "@/lib/mlb-prop";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { extractNhlRosterPlayers } from "@/server/data/nhl-roster";
import { extractNhlBoxScore } from "@/server/data/nhl-boxscore";
import { gradeNhlPlayerProp, type NhlPropPick } from "@/server/data/nhl-prop-grading";
import { extractMlbRosterPlayers, MLB_TEAM_IDS } from "@/server/data/mlb-roster";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const fixtures = path.join(__dirname, "..", "server", "data", "__fixtures__");
const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
const nhlRoster: RosterPlayer[] = extractNhlRosterPlayers("Pittsburgh Penguins", fx("nhl-roster-pit.json"));
const pitBox = extractNhlBoxScore(fx("nhl-boxscore-401879457-pit-buf.json"))!;
const mlbRaw = fx("mlb-roster-sample.json") as Record<string, unknown>;
const mlbRoster: RosterPlayer[] = Object.entries(mlbRaw).flatMap(([id, resp]) => extractMlbRosterPlayers(MLB_TEAM_IDS.find(([t]) => t === id)![1], resp));

// The import flow: parseCatalog, then the roster pass with the NHL and MLB rosters.
function importLine(line: string) {
  const parsed = parseCatalog(["Krash", line].join("\n"));
  const rec = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, [], [], parsed.picks, nhlRoster, mlbRoster);
  const pick = parsed.picks[0] ?? rec.recovered[0];
  return pick
    ? { betType: pick.betType, sport: pick.sportName, team: pick.teamNicknames[0] ?? null, desc: pick.description }
    : { unresolved: rec.stillUnresolved };
}

async function main() {
  console.log("########## PART A: NHL player goals lines ##########");
  {
    for (const [text, rewritten, side] of [
      ["Anton Lundell over 0.5 goals", "Anton Lundell Anytime Goal", "YES"],
      ["Anton Lundell o0.5 goals", "Anton Lundell Anytime Goal", "YES"],
      ["Anton Lundell over 0.5 goal", "Anton Lundell Anytime Goal", "YES"],
      ["Anton Lundell over 0.5 total goals", "Anton Lundell Anytime Goal", "YES"],
      ["Anton Lundell over 0.5 goals (+150)", "Anton Lundell Anytime Goal (+150)", "YES"],
      ["NHL: Connor McDavid over 0.5 goals -120", "NHL: Connor McDavid Anytime Goal -120", "YES"],
      ["Anton Lundell under 0.5 goals", "Anton Lundell No Goal Scorer", "NO"],
      ["Anton Lundell u0.5 goals", "Anton Lundell No Goal Scorer", "NO"],
    ] as const) {
      const n = normalizeNhlPlayerGoalsLine(text);
      check(`"${text}" -> "${rewritten}"`, n, rewritten);
      check(`  ANYTIME_GOAL, side ${side}`, [parseNhlPlayerProp(n)?.propMarket, nhlAnytimeGoalSide(n)], ["ANYTIME_GOAL", side]);
      check(`  a PLAYER_PROP, never a TOTAL`, parsePickText(text).betType, "PLAYER_PROP");
    }
    // Any other number is a multi-goal bet: a recognized NHL player prop this app does not grade -
    // routed to the unsupported list, never a game total.
    for (const text of ["Connor McDavid over 1.5 goals", "Connor McDavid over 2.5 total goals", "Connor McDavid under 1.5 goals"]) {
      check(`"${text}" is an unsupported NHL prop`, detectUnsupportedPropLine(text), { sport: "NHL", reason: UNSUPPORTED_PROP_REASONS.NHL });
      check(`  not rewritten to anytime goal`, normalizeNhlPlayerGoalsLine(text), text);
      check(`  a PLAYER_PROP, never a TOTAL`, parsePickText(text).betType, "PLAYER_PROP");
    }
  }

  console.log("\n########## PART B: through the import flow + NHL roster pass ##########");
  {
    check("over 0.5 goals -> NHL anytime-goal pick on the roster's team", importLine("Sidney Crosby over 0.5 goals"),
      { betType: "PLAYER_PROP", sport: "NHL", team: "pittsburgh penguins", desc: "Sidney Crosby Anytime Goal" });
    check("under 0.5 goals -> NHL no-goal pick", importLine("Evgeni Malkin under 0.5 goals"),
      { betType: "PLAYER_PROP", sport: "NHL", team: "pittsburgh penguins", desc: "Evgeni Malkin No Goal Scorer" });
    check("over 1.5 goals -> stays unresolved (unsupported), never a game total", importLine("Sidney Crosby over 1.5 goals"), { unresolved: ["Sidney Crosby over 1.5 goals"] });
    check("unknown player -> stays unresolved, never a game total", importLine("Zed Nobody over 0.5 goals"), { unresolved: ["Zed Nobody Anytime Goal"] });
  }

  console.log("\n########## PART C: grading the NO side (under 0.5 goals) ##########");
  {
    // PIT @ BUF fixture: Crosby 1 goal, Malkin 0 goals. The stored text is the rewritten one.
    const pick = (playerName: string, betDetail: string): NhlPropPick => ({ playerName, propMarket: "ANYTIME_GOAL", betDetail, homeTeam: "Buffalo Sabres", awayTeam: "Pittsburgh Penguins" });
    const grade = (p: NhlPropPick) => gradeNhlPlayerProp(p, "test", { fetchBox: async () => pitBox, getRoster: async () => nhlRoster });
    const under = (name: string) => normalizeNhlPlayerGoalsLine(name + " under 0.5 goals");
    const over = (name: string) => normalizeNhlPlayerGoalsLine(name + " over 0.5 goals");
    check("under 0.5 goals, player scores 0 -> WIN", await grade(pick("Evgeni Malkin", under("Evgeni Malkin"))), { outcome: "WIN" });
    check("under 0.5 goals, player scores 1 -> LOSS", await grade(pick("Sidney Crosby", under("Sidney Crosby"))), { outcome: "LOSS" });
    check("over 0.5 goals, player scores 1 -> WIN", await grade(pick("Sidney Crosby", over("Sidney Crosby"))), { outcome: "WIN" });
    check("over 0.5 goals, player scores 0 -> LOSS", await grade(pick("Evgeni Malkin", over("Evgeni Malkin"))), { outcome: "LOSS" });
  }

  console.log("\n########## PART D: MLB \"total <stat>\" ##########");
  {
    for (const [text, market, line] of [
      ["Aaron Judge over 1.5 total hits", "HITS", 1.5],
      ["Aaron Judge over 0.5 total rbis", "RBIS", 0.5],
      ["Aaron Judge over 0.5 total home runs", "HOME_RUNS", 0.5],
      ["Aaron Judge over 0.5 total runs", "RUNS", 0.5],
      ["Aaron Judge over 0.5 total walks", "WALKS", 0.5],
      ["Aaron Judge total hits over 1.5", "HITS", 1.5],
      ["Gerrit Cole over 6.5 total strikeouts", "STRIKEOUTS", 6.5],
      ["Gerrit Cole over 17.5 total outs recorded", "OUTS_RECORDED", 17.5],
      ["Gerrit Cole over 17.5 total outs", "OUTS_RECORDED", 17.5],
    ] as const) {
      const name = text.startsWith("Gerrit") ? "Gerrit Cole" : "Aaron Judge";
      check(`"${text}" -> ${market} ${line}, player "${name}"`, parseMlbPlayerProp(text), { playerName: name, propMarket: market, line });
      check(`  same as without "total"`, parseMlbPlayerProp(text), parseMlbPlayerProp(text.replace(/total\s+/i, "")));
      check(`  a PLAYER_PROP, never a TOTAL`, parsePickText(text).betType, "PLAYER_PROP");
    }
    check("through import + MLB roster: Aaron Judge over 1.5 total hits", importLine("Aaron Judge over 1.5 total hits"),
      { betType: "PLAYER_PROP", sport: "MLB", team: "new york yankees", desc: "Aaron Judge over 1.5 total hits" });
    check("the grading line reads through 'total'", parsePlayerPropLine("Aaron Judge over 1.5 total hits"), { direction: "OVER", line: 1.5 });
    // "total bases" is its own market: unchanged.
    check("total bases is still TOTAL_BASES", parseMlbPlayerProp("Aaron Judge over 1.5 total bases"), { playerName: "Aaron Judge", propMarket: "TOTAL_BASES", line: 1.5 });
    check("total bases via parseAnyPlayerProp", parseAnyPlayerProp("Aaron Judge over 1.5 total bases")?.propMarket, "TOTAL_BASES");
    check("total bases is a PLAYER_PROP", parsePickText("Aaron Judge over 1.5 total bases").betType, "PLAYER_PROP");
  }

  console.log("\n########## PART E: guards - game, team and matchup totals unchanged ##########");
  {
    for (const [text, betType] of [
      ["Over 6.5", "TOTAL"],
      ["Over 6.5 total", "TOTAL"],
      ["Under 6.5 total", "TOTAL"],
      ["Over 6.5 goals", "TOTAL"],
      ["Panthers over 3.5 goals", "TOTAL"],
      ["Panthers over 0.5 goals", "TOTAL"],
      ["Florida over 3.5 goals", "TOTAL"],
      ["Edmonton over 0.5 goals", "TOTAL"],
      ["Florida Panthers over 3.5 goals", "TOTAL"],
      ["Panthers vs Oilers over 6.5 goals", "TOTAL"],
      ["Panthers vs Oilers over 6.5 total goals", "TOTAL"],
      ["Avalanche versus Stars first period over 1.5 goals", "TOTAL"],
      ["Yankees over 8.5 runs", "TOTAL"],
      ["Yankees over 8.5 total runs", "TOTAL"],
      ["Yankees vs Red Sox over 8.5 total runs", "TOTAL"],
      ["Lakers over 220.5 total points", "TOTAL"],
      ["Falcons over 16.5 total points", "TOTAL"],
    ] as const) {
      check(`"${text}" stays a ${betType}`, parsePickText(text).betType, betType);
      check(`  not rewritten`, normalizeNhlPlayerGoalsLine(text), text);
    }
    // A team or matchup subject never gets a player-goals reason.
    for (const text of ["Panthers over 3.5 goals", "Florida Panthers over 2.5 goals", "Panthers vs Oilers over 6.5 goals", "Florida over 1.5 goals"]) {
      check(`"${text}" is not flagged as a player prop`, detectUnsupportedPropLine(text), null);
    }
    // Through the import flow: game / team totals still import as TOTAL picks.
    check("import: Florida Panthers over 3.5 goals -> NHL TOTAL", importLine("Florida Panthers over 3.5 goals"),
      { betType: "TOTAL", sport: "NHL", team: "florida panthers", desc: "Florida Panthers over 3.5 goals" });
    check("import: Panthers vs Oilers over 6.5 goals -> NHL TOTAL", importLine("Panthers vs Oilers over 6.5 goals").betType, "TOTAL");
    // A period-scoped player line is a different market: left as it was (not an anytime goal).
    check("1st period over 0.5 goals is not rewritten to anytime goal", normalizeNhlPlayerGoalsLine("Connor McDavid 1st period over 0.5 goals"), "Connor McDavid 1st period over 0.5 goals");
    // A hits total for a team / a game is a stat total this app does not grade (graded on runs as a TOTAL it
    // would be wrong) - it now gets the same reason "Yankees over 9.5 hits" (no "total") already got.
    check("team hits total -> TEAM_STAT reason", detectUnsupportedPropLine("Yankees over 9.5 total hits")?.reason, UNSUPPORTED_PROP_REASONS.TEAM_STAT);
    check("game hits total -> GAME_STAT reason", detectUnsupportedPropLine("Yankees vs Red Sox over 8.5 total hits")?.reason, UNSUPPORTED_PROP_REASONS.GAME_STAT);
    check("...same as without 'total'", detectUnsupportedPropLine("Yankees over 9.5 hits")?.reason, UNSUPPORTED_PROP_REASONS.TEAM_STAT);
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
