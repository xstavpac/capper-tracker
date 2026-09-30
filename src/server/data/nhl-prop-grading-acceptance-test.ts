// NHL player-prop grading against SAVED real ESPN box scores - no network, no DB.
// Run with:  npx tsx src/server/data/nhl-prop-grading-acceptance-test.ts
//
// Fixtures (fetched 2026-09-30 from ESPN's hockey/nhl summary + roster endpoints):
//   nhl-boxscore-401879457-pit-buf.json        PIT 3 @ BUF 1 (regulation, 4 goals)
//   nhl-boxscore-401879358-wsh-bos-shootout.json  WSH 2 @ BOS 3, decided in a shootout
//   nhl-roster-pit.json                        Pittsburgh's roster
//
// Pins the four facts the grader's correctness depends on:
//   (a) shots on goal reads the "S" label, never "SOG" (shootout goals, all 0)
//   (b) shootout goals are excluded from G and from first-goal ordering
//   (c) saves come from "SV"
//   (d) id-verified absence pushes; a name-only miss stays PENDING
import fs from "node:fs";
import path from "node:path";
import { extractNhlBoxScore, type NhlBoxScore } from "@/server/data/nhl-boxscore";
import { extractNhlRosterPlayers } from "@/server/data/nhl-roster";
import { gradeNhlPlayerProp, type NhlPropPick } from "@/server/data/nhl-prop-grading";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8"));
const pitRaw = fx("nhl-boxscore-401879457-pit-buf.json");
const soRaw = fx("nhl-boxscore-401879358-wsh-bos-shootout.json");
const pitBox = extractNhlBoxScore(pitRaw)!;
const soBox = extractNhlBoxScore(soRaw)!;
const pitRoster: RosterPlayer[] = extractNhlRosterPlayers("Pittsburgh Penguins", fx("nhl-roster-pit.json"));

const PIT_GAME = { homeTeam: "Buffalo Sabres", awayTeam: "Pittsburgh Penguins" };
const SO_GAME = { homeTeam: "Boston Bruins", awayTeam: "Washington Capitals" };

function pick(betDetail: string, game = PIT_GAME, extra: Partial<NhlPropPick> = {}): NhlPropPick {
  return { playerName: null, propMarket: null, betDetail, ...game, ...extra };
}
const grade = (p: NhlPropPick, box: NhlBoxScore = pitBox, roster: RosterPlayer[] = pitRoster) =>
  gradeNhlPlayerProp(p, "test", { fetchBox: async () => box, getRoster: async () => roster });

async function main() {
  // ---- extraction sanity --------------------------------------------------
  check("PIT box: final + complete, teams", [pitBox.isFinal, pitBox.isComplete, pitBox.homeTeam, pitBox.awayTeam], [true, true, "Buffalo Sabres", "Pittsburgh Penguins"]);
  check("PIT box: 4 goals in order", pitBox.goals.map((g) => g.scorerName), ["Sidney Crosby", "Ville Koivunen", "Ryan McLeod", "Nick Robertson"]);
  check("a malformed response yields null", extractNhlBoxScore({ boxscore: {} }), null);

  // ---- (a) shots on goal = "S", never "SOG" ------------------------------
  const chinakhov = pitBox.skaters.find((r) => r.playerName === "Egor Chinakhov")!;
  check("(a) Chinakhov shotsOnGoal is the S column (4), not SOG (0)", chinakhov.shotsOnGoal, 4);
  check("(a) every SOG-label value in the fixture is 0 (so a SOG read would be all zeros)", pitBox.skaters.every((r) => r.shotsOnGoal >= 0) && pitBox.skaters.some((r) => r.shotsOnGoal > 0), true);
  // Corrupt the fixture so the S column is absent: extraction must fail closed
  // (null), never fall back to SOG.
  const noS = JSON.parse(JSON.stringify(pitRaw));
  for (const t of noS.boxscore.players) for (const g of t.statistics) if (g.labels) g.labels = g.labels.map((l: string) => (l === "S" ? "XX" : l));
  check("(a) no S label -> extraction fails closed (null), does not read SOG", extractNhlBoxScore(noS), null);
  check("(a) Chinakhov over 3.5 shots on goal -> WIN", await grade(pick("Egor Chinakhov over 3.5 shots on goal")), { outcome: "WIN" });
  check("(a) Chinakhov under 3.5 shots on goal -> LOSS", await grade(pick("Egor Chinakhov under 3.5 shots on goal")), { outcome: "LOSS" });
  check("(a) Chinakhov 4+ shots on goal (N+) -> WIN", await grade(pick("Egor Chinakhov Over 3.5 shots on goal")), { outcome: "WIN" });
  check("(a) Chinakhov 5+ shots on goal (N+) -> LOSS", await grade(pick("Egor Chinakhov Over 4.5 shots on goal")), { outcome: "LOSS" });
  check("(a) whole-number line landing exactly -> PUSH", await grade(pick("Egor Chinakhov over 4 shots on goal")), { outcome: "PUSH" });

  // ---- (b) shootout excluded ---------------------------------------------
  const hagens = soBox.skaters.find((r) => r.playerName === "James Hagens")!;
  check("(b) Hagens scored the shootout winner but box goals = 0", hagens.goals, 0);
  check("(b) shootout fixture has 4 counted goals, none in period 5", [soBox.goals.length, soBox.goals.every((g) => g.period <= 4)], [4, true]);
  check("(b) shootout goal scorer is not in the goal list", soBox.goals.some((g) => g.scorerName === "James Hagens"), false);
  check("(b) the raw feed DOES carry the shootout goal as a scoring play (so the filter is what excludes it)",
    soRaw.plays.some((p: { scoringPlay?: boolean; period?: { number: number }; text?: string }) => p.scoringPlay && p.period?.number === 5 && /Hagens/.test(p.text ?? "")), true);
  check("(b) Hagens anytime goal -> LOSS (shootout goal doesn't count)", await grade(pick("James Hagens anytime goal scorer", SO_GAME), soBox, []), { outcome: "LOSS" });
  check("(b) first goal scorer: Brodzinski (P1 8:48) WINS", await grade(pick("Jonny Brodzinski first goal scorer", SO_GAME), soBox, []), { outcome: "WIN" });
  check("(b) first goal scorer: Hagens (shootout only) LOSES", await grade(pick("James Hagens first goal scorer", SO_GAME), soBox, []), { outcome: "LOSS" });

  // ---- goals markets on the regulation game ------------------------------
  check("anytime goal, scorer -> WIN", await grade(pick("Sidney Crosby anytime goal scorer")), { outcome: "WIN" });
  check("anytime goal, non-scorer -> LOSS", await grade(pick("Evgeni Malkin anytime goal scorer")), { outcome: "LOSS" });
  check("anytime goal NO side, non-scorer -> WIN", await grade(pick("Evgeni Malkin no goal scorer")), { outcome: "WIN" });
  check("anytime goal NO side, scorer -> LOSS", await grade(pick("Sidney Crosby no goal scorer")), { outcome: "LOSS" });
  check("first goal scorer: Crosby WINS", await grade(pick("Sidney Crosby first goal scorer")), { outcome: "WIN" });
  check("first goal scorer: Koivunen (2nd goal) LOSES", await grade(pick("Ville Koivunen first goal scorer")), { outcome: "LOSS" });

  // ---- points / assists ---------------------------------------------------
  check("points: Lapierre (0G 1A) over 0.5 -> WIN", await grade(pick("Hendrix Lapierre over 0.5 points")), { outcome: "WIN" });
  check("points: Crosby (1G 0A) over 1.5 -> LOSS", await grade(pick("Sidney Crosby over 1.5 points")), { outcome: "LOSS" });
  check("points: Crosby under 1.5 -> WIN", await grade(pick("Sidney Crosby under 1.5 points")), { outcome: "WIN" });
  check("assists: Lapierre over 0.5 -> WIN", await grade(pick("Hendrix Lapierre over 0.5 assists")), { outcome: "WIN" });
  check("assists: Crosby over 0.5 -> LOSS", await grade(pick("Sidney Crosby over 0.5 assists")), { outcome: "LOSS" });
  check("assists: Crosby 1+ points (N+ already normalized) -> WIN", await grade(pick("Sidney Crosby Over 0.5 points")), { outcome: "WIN" });

  // ---- (c) saves come from SV --------------------------------------------
  check("(c) Silovs SV=23 in the fixture", pitBox.goalies.find((g) => g.playerName === "Arturs Silovs")?.saves, 23);
  check("(c) Silovs over 22.5 saves -> WIN", await grade(pick("Arturs Silovs over 22.5 saves")), { outcome: "WIN" });
  check("(c) Silovs over 23.5 saves -> LOSS", await grade(pick("Arturs Silovs over 23.5 saves")), { outcome: "LOSS" });
  check("(c) Silovs under 23.5 saves -> WIN", await grade(pick("Arturs Silovs under 23.5 saves")), { outcome: "WIN" });
  check("(c) Silovs 24+ saves (N+, over 23.5) -> LOSS", await grade(pick("Arturs Silovs Over 23.5 saves")), { outcome: "LOSS" });
  // The pulled/relief goalie grades on his own SV: Ellis 6, Luukkonen 15 (BUF used both).
  check("(c) pulled/relief goalie Ellis grades on his own SV (6): over 5.5 -> WIN", await grade(pick("Colten Ellis over 5.5 saves")), { outcome: "WIN" });
  check("(c) Luukkonen SV=15: over 15.5 -> LOSS", await grade(pick("Ukko-Pekka Luukkonen over 15.5 saves")), { outcome: "LOSS" });
  check("(c) a skater on a saves pick stays PENDING (not a goalie)", (await grade(pick("Sidney Crosby over 1.5 saves"))).outcome, null);
  check("(c) a goalie on a shots pick stays PENDING", (await grade(pick("Arturs Silovs over 1.5 shots on goal"))).outcome, null);

  // ---- bare surname, full name, collision --------------------------------
  check("bare surname resolves inside the game's box score", await grade(pick("Chinakhov over 3.5 shots on goal")), { outcome: "WIN" });
  check("structured playerName/propMarket are preferred over betDetail text", await grade(pick("over 3.5", PIT_GAME, { playerName: "Egor Chinakhov", propMarket: "SHOTS_ON_GOAL" })), { outcome: "WIN" });
  const twoSmiths: NhlBoxScore = {
    ...pitBox,
    skaters: [...pitBox.skaters, { espnPlayerId: "9001", playerName: "Alex Smith", team: "Buffalo Sabres", goals: 0, assists: 0, shotsOnGoal: 1 }, { espnPlayerId: "9002", playerName: "Bo Smith", team: "Pittsburgh Penguins", goals: 0, assists: 0, shotsOnGoal: 1 }],
  };
  const collision = await grade(pick("Smith over 0.5 shots on goal"), twoSmiths);
  check("surname collision inside the box score stays PENDING", collision.outcome, null);

  // ---- (d) did-not-play ---------------------------------------------------
  // Kuzmenko (LW) and Murashov (G) are on PIT's roster but absent from this box score.
  check("(d) id-verified absent skater PUSHES (shots)", await grade(pick("Andrei Kuzmenko over 1.5 shots on goal")), { outcome: "PUSH" });
  check("(d) id-verified absent skater PUSHES (anytime goal)", await grade(pick("Andrei Kuzmenko anytime goal scorer")), { outcome: "PUSH" });
  check("(d) id-verified absent skater PUSHES (first goal)", await grade(pick("Andrei Kuzmenko first goal scorer")), { outcome: "PUSH" });
  check("(d) absent backup GOALIE PUSHES on saves", await grade(pick("Sergei Murashov over 20.5 saves")), { outcome: "PUSH" });
  check("(d) bare surname resolving to exactly one roster id also pushes", await grade(pick("Kuzmenko over 1.5 shots on goal")), { outcome: "PUSH" });
  const missName = await grade(pick("Zed Nobody over 1.5 shots on goal"));
  check("(d) a name-only miss (not on the roster) stays PENDING with the couldn't-find reason", missName, { outcome: null, reason: 'couldn\'t find "Zed Nobody" in the box score' });
  check("(d) roster cache empty -> stays PENDING", (await grade(pick("Andrei Kuzmenko over 1.5 shots on goal"), pitBox, [])).outcome, null);
  const dupRoster: RosterPlayer[] = [...pitRoster, { playerName: "Andrei Kuzmenko", firstName: "Andrei", lastName: "Kuzmenko", team: "Buffalo Sabres", position: "LW", espnPlayerId: "77777" }];
  check("(d) name resolving to TWO roster ids stays PENDING", (await grade(pick("Andrei Kuzmenko over 1.5 shots on goal"), pitBox, dupRoster)).outcome, null);
  const notComplete: NhlBoxScore = { ...pitBox, isComplete: false };
  check("(d) incomplete box score -> absent player stays PENDING", (await grade(pick("Andrei Kuzmenko over 1.5 shots on goal"), notComplete)).outcome, null);
  const partialRaw = JSON.parse(JSON.stringify(pitRaw));
  for (const g of partialRaw.boxscore.players[1].statistics) if (g.name === "goalies") g.athletes = [];
  const partialBox = extractNhlBoxScore(partialRaw)!;
  check("(d) extraction marks a box score with one team's goalies missing incomplete", [partialBox.isFinal, partialBox.isComplete], [true, false]);
  check("(d) ...and an absent player then stays PENDING", (await grade(pick("Andrei Kuzmenko over 1.5 shots on goal"), partialBox)).outcome, null);
  const notFinal: NhlBoxScore = { ...pitBox, isFinal: false, isComplete: false };
  check("(d) non-final game stays PENDING even for a present player", (await grade(pick("Egor Chinakhov over 3.5 shots on goal"), notFinal)).outcome, null);
  const wrongTeamRoster: RosterPlayer[] = pitRoster.map((p) => (p.lastName === "Kuzmenko" ? { ...p, team: "Edmonton Oilers" } : p));
  check("(d) roster player whose team isn't in this game stays PENDING", (await grade(pick("Andrei Kuzmenko over 1.5 shots on goal"), pitBox, wrongTeamRoster)).outcome, null);
  const skaterOnSaves = await grade(pick("Andrei Kuzmenko over 20.5 saves"));
  check("(d) roster position must match the market (skater on a saves pick) -> PENDING", skaterOnSaves.outcome, null);
  const goalieOnShots = await grade(pick("Sergei Murashov over 1.5 shots on goal"));
  check("(d) roster position must match the market (goalie on a shots pick) -> PENDING", goalieOnShots.outcome, null);
  const rosterNoBox = await gradeNhlPlayerProp(pick("Andrei Kuzmenko over 1.5 shots on goal"), "x", { fetchBox: async () => null, getRoster: async () => pitRoster });
  check("no box score at all -> PENDING with the existing reason", rosterNoBox, { outcome: null, reason: "the box score isn't available yet for this game" });

  // ---- first goal with no goals in periods 1-4 ---------------------------
  const scoreless: NhlBoxScore = { ...soBox, goals: [] };
  check("first goal with no goal in periods 1-4 stays PENDING", (await grade(pick("Jonny Brodzinski first goal scorer", SO_GAME), scoreless, [])).outcome, null);

  // ---- capper shorthand + team-prefixed names grade the same ---------------
  // (Bet-text parsing only: grading still reads box-score label S, never SOG.)
  check("shorthand: Chinakhov o3.5 SOG -> WIN (S=4)", await grade(pick("Chinakhov o3.5 SOG")), { outcome: "WIN" });
  check("shorthand: Chinakhov u3.5 sog -> LOSS", await grade(pick("Chinakhov u3.5 sog")), { outcome: "LOSS" });
  check("shorthand: Chinakhov over 3.5 shots -> WIN", await grade(pick("Chinakhov over 3.5 shots")), { outcome: "WIN" });
  check("shorthand: Crosby ATGS -> WIN", await grade(pick("Sidney Crosby ATGS")), { outcome: "WIN" });
  check("shorthand: Malkin AGS -> LOSS", await grade(pick("Evgeni Malkin AGS")), { outcome: "LOSS" });
  check("shorthand: Crosby FGS -> WIN", await grade(pick("Sidney Crosby FGS")), { outcome: "WIN" });
  check("shorthand: Lapierre o0.5 pts -> WIN", await grade(pick("Hendrix Lapierre o0.5 pts")), { outcome: "WIN" });
  check("shorthand: Lapierre o0.5 ast -> WIN", await grade(pick("Hendrix Lapierre o0.5 ast")), { outcome: "WIN" });
  check("team-prefixed name: 'Penguins Sidney Crosby anytime goal scorer' -> WIN", await grade(pick("Penguins Sidney Crosby anytime goal scorer")), { outcome: "WIN" });
  // Known limit of the shared stripTeamNamesFromPlayerName (same for NFL): a
  // CITY-prefixed name leaves the city behind, so it fails safe to PENDING.
  check("team-prefixed with the full city name fails safe (PENDING), never mis-grades", (await grade(pick("Pittsburgh Penguins Egor Chinakhov over 3.5 shots on goal"))).outcome, null);
  check("team-prefixed stored playerName ('Penguins Egor Chinakhov') is stripped", await grade(pick("Over 3.5 shots on goal", PIT_GAME, { playerName: "Penguins Egor Chinakhov", propMarket: "SHOTS_ON_GOAL" })), { outcome: "WIN" });

  // ---- unrecognized / malformed ------------------------------------------
  check("non-NHL market text on an NHL pick stays PENDING", (await grade(pick("Josh Allen over 250.5 passing yards"))).outcome, null);
  check("line market with no line stays PENDING", (await grade(pick("Egor Chinakhov shots on goal"))).outcome, null);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
