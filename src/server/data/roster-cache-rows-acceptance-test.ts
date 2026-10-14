// Proof for the two roster views (roster-cache-rows.ts): import matching sees
// active players only, grading sees every row - so a pending prop on a player a
// refresh has since marked inactive still grades. Run with:
//   npx tsx src/server/data/roster-cache-rows-acceptance-test.ts
//
// No database and no network. The grading half reuses the real NHL fixtures of
// nhl-prop-grading-acceptance-test.ts: PIT @ BUF (2026-09-29), where Andrei
// Kuzmenko is on Pittsburgh's roster but absent from the box score, so an
// id-verified roster hit PUSHES his prop.
import fs from "node:fs";
import path from "node:path";
import { buildRosterViews } from "./roster-cache-rows";
import { extractNhlBoxScore } from "./nhl-boxscore";
import { extractNhlRosterPlayers } from "./nhl-roster";
import { gradeNhlPlayerProp } from "./nhl-prop-grading";
import { resolveNameAgainstRoster } from "@/lib/player-roster-fallback";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8"));
const pitBox = extractNhlBoxScore(fx("nhl-boxscore-401879457-pit-buf.json"))!;
const pitRoster = extractNhlRosterPlayers("Pittsburgh Penguins", fx("nhl-roster-pit.json"));

async function main() {
  console.log("########## PART A: the two views ##########");
  // The table rows as a cache read returns them, Kuzmenko since marked inactive.
  const rows = pitRoster.map((p) => ({ fullName: p.playerName, firstName: p.firstName, lastName: p.lastName, team: p.team, position: p.position, espnPlayerId: p.externalPlayerId, active: p.playerName !== "Andrei Kuzmenko" }));
  const views = buildRosterViews(rows, (r) => r.espnPlayerId);
  const kuzmenko = pitRoster.find((p) => p.playerName === "Andrei Kuzmenko")!;
  check("the fixture has Kuzmenko", !!kuzmenko, true);
  check("grading view: every row, in the shared RosterPlayer shape", views.grading, pitRoster);
  check("matching view: everyone but the inactive player", views.matching.map((p) => p.externalPlayerId), pitRoster.filter((p) => p !== kuzmenko).map((p) => p.externalPlayerId));
  check("both views share the same player objects (no copies)", views.matching.every((p) => views.grading.includes(p)), true);
  check("all active -> matching view has everyone", buildRosterViews(rows.map((r) => ({ ...r, active: true })), (r) => r.espnPlayerId).matching.length, pitRoster.length);
  check("all inactive -> matching view is empty, grading view is not", (() => {
    const v = buildRosterViews(rows.map((r) => ({ ...r, active: false })), (r) => r.espnPlayerId);
    return [v.matching.length, v.grading.length];
  })(), [0, pitRoster.length]);

  console.log("\n########## PART B: import matching skips an inactive player ##########");
  check("matching view: Kuzmenko does not resolve at import", resolveNameAgainstRoster("Andrei Kuzmenko", views.matching, undefined, "NHL").status === "resolved", false);
  check("grading view would have resolved him (so the exclusion is the active flag)", resolveNameAgainstRoster("Andrei Kuzmenko", views.grading, undefined, "NHL").status, "resolved");

  console.log("\n########## PART C: an inactive player's pending prop still grades ##########");
  const pick = { playerName: null, propMarket: null, betDetail: "Andrei Kuzmenko over 1.5 shots on goal", homeTeam: "Buffalo Sabres", awayTeam: "Pittsburgh Penguins" };
  const viaGrading = await gradeNhlPlayerProp(pick, "test", { fetchBox: async () => pitBox, getRoster: async () => views.grading });
  const viaMatching = await gradeNhlPlayerProp(pick, "test", { fetchBox: async () => pitBox, getRoster: async () => views.matching });
  check("with the grading view: id-verified did-not-play -> PUSH", viaGrading, { outcome: "PUSH" });
  check("with the matching view it could NOT grade (why grading must not use it)", viaMatching.outcome, null);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
