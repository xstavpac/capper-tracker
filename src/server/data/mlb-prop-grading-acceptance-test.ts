// MLB player-prop grading against SAVED real MLB Stats API box scores - no network, no DB.
// Run with:  npx tsx src/server/data/mlb-prop-grading-acceptance-test.ts
//
// Fixtures (real responses fetched 2026-09-30, reduced to the fields the extractors read - see
// scripts/capture-mlb-fixtures.mjs). The four Wild Card games are THIS POSTSEASON's:
//   mlb-boxscore-849845-atl-phi-wc.json      PHI @ ATL (Wild Card)   Sale 9 K / 19 outs, Luzardo 6 K / 15 outs
//   mlb-boxscore-849849-hou-chw-wc.json      CHW @ HOU (Wild Card)   Pena (accent) and Velazquez (HR, 4 TB, 2 RBI)
//   mlb-boxscore-849851-nyy-bos-wc.json      BOS @ NYY (Wild Card)
//   mlb-boxscore-849843-sd-chc-wc.json       CHC @ SD  (Wild Card)
// and regular-season games chosen for the Phase 1 edge cases:
//   mlb-boxscore-824954-ath-sea-ferrer.json  SEA @ ATH   "Jose A. Ferrer" (name variant), pinch runner scoring with PA 0
//   mlb-boxscore-822924-tb-ath-cook.json     ATH @ TB    "Alex Cook" (box) vs "Alexander Cook" (capper)
//   mlb-boxscore-823164-lad-ohtani-dh.json   LAD @ SF    Ohtani (TWP) hitting only; Max Muncy 2 BB
//   mlb-roster-sample.json                   40-man rosters for 14 teams (both Max Muncys, both Jose Fermins)
//
// Pins the facts the grader's correctness depends on:
//   (a) every market reads the right Stats API field (TB = totalBases, outs = outs, BB = baseOnBalls, ...)
//   (b) PA = 0 pushes the PA-gated hitter markets but RUNS grades off the recorded value
//   (c) a named pitcher who did not start pushes, even after relieving
//   (d) id-verified true absence pushes; a name-only miss / collision / partial box stays PENDING
//   (e) accented names and first-name short forms match; two real "Max Muncy"s never do
//   (f) position-aware: hitter on a K line and pitcher on a hitter line stay PENDING with a reason
import fs from "node:fs";
import path from "node:path";
import { extractMlbBoxScore, type MlbBoxScore } from "@/server/data/mlb-boxscore";
import { extractMlbRosterPlayers, MLB_TEAM_IDS } from "@/server/data/mlb-roster";
import { gradeMlbPlayerProp, type MlbPropPick } from "@/server/data/mlb-prop-grading";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8"));
const box = (file: string, isFinal = true) => extractMlbBoxScore(fx(file), isFinal)!;

const G1 = { file: "mlb-boxscore-849845-atl-phi-wc.json", homeTeam: "Atlanta Braves", awayTeam: "Philadelphia Phillies" };
const G2 = { file: "mlb-boxscore-849849-hou-chw-wc.json", homeTeam: "Houston Astros", awayTeam: "Chicago White Sox" };
const G3 = { file: "mlb-boxscore-823164-lad-ohtani-dh.json", homeTeam: "San Francisco Giants", awayTeam: "Los Angeles Dodgers" };
const G4 = { file: "mlb-boxscore-824954-ath-sea-ferrer.json", homeTeam: "Athletics", awayTeam: "Seattle Mariners" };
const G5 = { file: "mlb-boxscore-822924-tb-ath-cook.json", homeTeam: "Tampa Bay Rays", awayTeam: "Athletics" };

const rosterRaw = fx("mlb-roster-sample.json") as Record<string, unknown>;
const roster: RosterPlayer[] = Object.entries(rosterRaw).flatMap(([id, resp]) => {
  const team = MLB_TEAM_IDS.find(([tid]) => tid === id)![1];
  return extractMlbRosterPlayers(team, resp);
});

type Game = typeof G1;
function pick(betDetail: string, game: Game, extra: Partial<MlbPropPick> = {}): MlbPropPick {
  return { playerName: null, propMarket: null, betDetail, homeTeam: game.homeTeam, awayTeam: game.awayTeam, ...extra };
}
async function grade(betDetail: string, game: Game, opts: { box?: MlbBoxScore | null; roster?: RosterPlayer[]; extra?: Partial<MlbPropPick> } = {}) {
  const b = opts.box === undefined ? box(game.file) : opts.box;
  return gradeMlbPlayerProp(pick(betDetail, game, opts.extra), "gamePk", { fetchBox: async () => b, getRoster: async () => opts.roster ?? roster });
}
const reason = async (p: ReturnType<typeof grade>) => {
  const r = await p;
  return r.outcome === null ? r.reason : "(graded " + r.outcome + ")";
};

async function main() {
  // ---- extraction sanity --------------------------------------------------
  const g1 = box(G1.file);
  check("G1 box: final + complete, teams", [g1.isFinal, g1.isComplete, g1.homeTeam, g1.awayTeam], [true, true, "Atlanta Braves", "Philadelphia Phillies"]);
  check("not-final flag carries through and kills isComplete", [box(G1.file, false).isFinal, box(G1.file, false).isComplete], [false, false]);
  check("a malformed response yields null", extractMlbBoxScore({ teams: {} }, true), null);
  const sale = g1.players.find((p) => p.playerName === "Chris Sale")!;
  check("Sale: started, 19 outs (6.1 IP), 9 K, no batting line", [sale.pitching, sale.batting], [{ gamesStarted: 1, outs: 19, strikeouts: 9 }, null]);
  const hicklen = g1.players.find((p) => p.playerName === "Brewer Hicklen")!;
  check("Hicklen: a batting line with PA 0 (entered as a substitute)", hicklen.batting?.plateAppearances, 0);
  const tellez = g1.players.find((p) => p.playerName === "Rowdy Tellez")!;
  check("Tellez: on the active roster but empty stats -> no batting, no pitching line", [tellez.batting, tellez.pitching], [null, null]);
  const iglesias = g1.players.find((p) => p.playerName === "Raisel Iglesias")!;
  check("Iglesias (pitcher): pitching line AND a zero batting line", [iglesias.pitching?.gamesStarted, iglesias.batting?.plateAppearances], [0, 0]);
  const velazquez = box(G2.file).players.find((p) => p.playerName === "Nelson Velázquez")!;
  check("Velazquez: TB is the Stats API totalBases (1 H + HR = 4)", [velazquez.batting?.hits, velazquez.batting?.homeRuns, velazquez.batting?.totalBases, velazquez.batting?.rbis], [1, 1, 4, 2]);
  check("a box with no players at all yields null", extractMlbBoxScore({ teams: { home: { team: { name: "A" }, players: {} }, away: { team: { name: "B" }, players: {} } } }, true), null);

  // ---- (a) every market reads the right field ------------------------------
  // Pitcher strikeouts / outs recorded (this postseason, Wild Card).
  check("Sale over 8.5 Ks -> WIN (9)", await grade("Chris Sale over 8.5 Ks", G1), { outcome: "WIN" });
  check("Sale under 8.5 Ks -> LOSS", await grade("Chris Sale under 8.5 Ks", G1), { outcome: "LOSS" });
  check("Sale 10+ Ks (over 9.5) -> LOSS", await grade("Chris Sale 10+ Ks", G1), { outcome: "LOSS" });
  check("Sale 9+ Ks (over 8.5) -> WIN", await grade("Chris Sale 9+ Ks", G1), { outcome: "WIN" });
  check("Sale over 9 Ks (whole number line) -> PUSH", await grade("Chris Sale over 9 Ks", G1), { outcome: "PUSH" });
  check("Luzardo (accent-free) over 5.5 strikeouts -> WIN (6)", await grade("Jesus Luzardo over 5.5 strikeouts", G1), { outcome: "WIN" });
  check("Sale over 18.5 outs recorded -> WIN (19 outs = 6.1 IP)", await grade("Chris Sale over 18.5 outs recorded", G1), { outcome: "WIN" });
  check("Sale 19+ outs -> WIN (over 18.5)", await grade("Chris Sale 19+ outs", G1), { outcome: "WIN" });
  check("Sale 20+ outs -> LOSS (over 19.5)", await grade("Chris Sale 20+ outs", G1), { outcome: "LOSS" });
  check("Luzardo under 15.5 outs -> WIN (15 = 5.0 IP)", await grade("Jesus Luzardo under 15.5 outs", G1), { outcome: "WIN" });
  check("Luzardo over 15 outs -> PUSH", await grade("Jesus Luzardo over 15 outs", G1), { outcome: "PUSH" });
  // Hitter markets.
  check("Pena (accent-free) over 0.5 hits -> WIN", await grade("Jeremy Pena over 0.5 hits", G2), { outcome: "WIN" });
  check("Pena 2+ hits -> LOSS (1)", await grade("Jeremy Pena 2+ hits", G2), { outcome: "LOSS" });
  check("Velazquez over 3.5 total bases -> WIN (4)", await grade("Nelson Velazquez over 3.5 total bases", G2), { outcome: "WIN" });
  check("Velazquez 4+ TB -> WIN", await grade("Nelson Velazquez 4+ TB", G2), { outcome: "WIN" });
  check("Velazquez 5+ TB -> LOSS", await grade("Nelson Velazquez 5+ TB", G2), { outcome: "LOSS" });
  check("Velazquez over 4 TB (whole number) -> PUSH", await grade("Nelson Velazquez over 4 TB", G2), { outcome: "PUSH" });
  check("Velazquez to hit a home run -> WIN", await grade("Nelson Velazquez to hit a home run", G2), { outcome: "WIN" });
  check("Velazquez 1+ HR -> WIN", await grade("Nelson Velazquez 1+ HR", G2), { outcome: "WIN" });
  check("Pena to hit a home run -> LOSS (PA 4, 0 HR: a real zero)", await grade("Jeremy Pena to hit a home run", G2), { outcome: "LOSS" });
  check("Velazquez 2+ RBI -> WIN (2)", await grade("Nelson Velazquez 2+ RBI", G2), { outcome: "WIN" });
  check("Velazquez 3+ RBIs -> LOSS", await grade("Nelson Velazquez 3+ RBIs", G2), { outcome: "LOSS" });
  check("Pena 1+ RBIs -> LOSS (0 RBI with PA 4 is a result)", await grade("Jeremy Pena 1+ RBIs", G2), { outcome: "LOSS" });
  check("Pena over 0.5 runs -> WIN (1)", await grade("Jeremy Pena over 0.5 runs", G2), { outcome: "WIN" });
  check("Pena 2+ runs scored -> LOSS", await grade("Jeremy Pena 2+ runs scored", G2), { outcome: "LOSS" });
  check("Muncy over 1.5 walks -> WIN (2 BB)", await grade("Max Muncy over 1.5 walks", G3), { outcome: "WIN" });
  check("Muncy 3+ BB -> LOSS", await grade("Max Muncy 3+ BB", G3), { outcome: "LOSS" });
  check("Trea Turner over 0.5 hits -> LOSS (PA 4, 0 H)", await grade("Trea Turner over 0.5 hits", G1), { outcome: "LOSS" });
  check("Trea Turner under 0.5 hits -> WIN", await grade("Trea Turner under 0.5 hits", G1), { outcome: "WIN" });
  check("bare surname (unique in the box): Baldwin over 0.5 hits -> LOSS", await grade("Baldwin over 0.5 hits", G1), { outcome: "LOSS" });
  check("team-prefixed name is stripped: Braves Chris Sale over 8.5 Ks -> WIN", await grade("Braves Chris Sale over 8.5 Ks", G1), { outcome: "WIN" });
  check("explicit propMarket/playerName on the pick are used", await grade("Over 8.5", G1, { extra: { playerName: "Chris Sale", propMarket: "STRIKEOUTS" } }), { outcome: "WIN" });

  // ---- (b) PA = 0 -----------------------------------------------------------
  check("PA 0: Hicklen over 0.5 hits -> PUSH", await grade("Brewer Hicklen over 0.5 hits", G1), { outcome: "PUSH" });
  check("PA 0: Hicklen under 0.5 hits -> PUSH (not a WIN on a 0)", await grade("Brewer Hicklen under 0.5 hits", G1), { outcome: "PUSH" });
  check("PA 0: Hicklen over 0.5 total bases -> PUSH", await grade("Brewer Hicklen over 0.5 total bases", G1), { outcome: "PUSH" });
  check("PA 0: Hicklen to hit a home run -> PUSH", await grade("Brewer Hicklen to hit a home run", G1), { outcome: "PUSH" });
  check("PA 0: Hicklen 1+ RBI -> PUSH", await grade("Brewer Hicklen 1+ RBI", G1), { outcome: "PUSH" });
  check("PA 0: Hicklen 1+ BB -> PUSH (a walk IS a plate appearance)", await grade("Brewer Hicklen 1+ BB", G1), { outcome: "PUSH" });
  check("PA 0: Luisangel Acuna (accent-free) over 0.5 total bases -> PUSH", await grade("Luisangel Acuna over 0.5 total bases", G2), { outcome: "PUSH" });
  // Runs: a pinch runner scores with no PA, so runs grade off the recorded value.
  check("PA 0 + scored: Stefanic (pinch runner) over 0.5 runs -> WIN", await grade("Michael Stefanic over 0.5 runs", G4), { outcome: "WIN" });
  check("PA 0 + scored: Stefanic under 0.5 runs -> LOSS", await grade("Michael Stefanic under 0.5 runs", G4), { outcome: "LOSS" });
  check("PA 0 + scored: Stefanic over 0.5 hits -> PUSH (contact market, PA 0)", await grade("Michael Stefanic over 0.5 hits", G4), { outcome: "PUSH" });
  check("PA 0, 0 runs: Serven over 0.5 runs -> LOSS (recorded 0, no PA-based void for runs)", await grade("Brian Serven over 0.5 runs", G4), { outcome: "LOSS" });
  check("PA 0, 0 runs: Serven under 0.5 runs -> WIN", await grade("Brian Serven under 0.5 runs", G4), { outcome: "WIN" });
  check("no batting line at all: Tellez over 0.5 runs -> PUSH (did not play)", await grade("Rowdy Tellez over 0.5 runs", G1), { outcome: "PUSH" });

  // ---- (c) pitcher must have started ---------------------------------------
  check("relief only: Iglesias over 0.5 Ks -> PUSH (did not start)", await grade("Raisel Iglesias over 0.5 Ks", G1), { outcome: "PUSH" });
  check("relief only: Iglesias under 0.5 Ks -> PUSH (not a WIN on a 0)", await grade("Raisel Iglesias under 0.5 Ks", G1), { outcome: "PUSH" });
  check("relief only: Iglesias over 2.5 outs -> PUSH", await grade("Raisel Iglesias over 2.5 outs", G1), { outcome: "PUSH" });
  check("did not pitch at all: Wheeler over 5.5 Ks -> PUSH", await grade("Zack Wheeler over 5.5 Ks", G1), { outcome: "PUSH" });
  check("did not bat (bench, empty stats): Tellez over 0.5 hits -> PUSH", await grade("Rowdy Tellez over 0.5 hits", G1), { outcome: "PUSH" });

  // ---- (e) name variants found in Phase 1 -----------------------------------
  check("'Alexander Cook' matches box 'Alex Cook' (relief) -> PUSH, not notFound", await grade("Alexander Cook over 1.5 Ks", G5), { outcome: "PUSH" });
  check("'Alex Cook' typed the short way also matches", await grade("Alex Cook over 1.5 Ks", G5), { outcome: "PUSH" });
  check("'Jose Ferrer' matches box 'José A. Ferrer' (accent + middle initial) -> PUSH, not notFound", await grade("Jose Ferrer over 0.5 Ks", G4), { outcome: "PUSH" });
  check("'Jose A Ferrer' matches too", await grade("Jose A Ferrer over 0.5 Ks", G4), { outcome: "PUSH" });
  check("accented typed name matches accent-free box name (Jesús Luzardo)", await grade("Jesús Luzardo over 5.5 Ks", G1), { outcome: "WIN" });
  check("Max Muncy in G3 (only the Dodgers' Muncy is in this box) grades", await grade("Max Muncy over 0.5 hits", G3), { outcome: "WIN" });

  // ---- (d) true absence ------------------------------------------------------
  check("roster-verified absence (PHI 40-man, not in the box): Adolis Garcia over 0.5 hits -> PUSH", await grade("Adolis Garcia over 0.5 hits", G1), { outcome: "PUSH" });
  check("roster-verified absence (ATL pitcher): Bryce Elder over 4.5 Ks -> PUSH", await grade("Bryce Elder over 4.5 Ks", G1), { outcome: "PUSH" });
  check("absence on the WRONG side stays PENDING (Bryce Elder is a pitcher; hitter market)", (await grade("Bryce Elder over 0.5 hits", G1)).outcome, null);
  check("absent player from a team NOT in this game stays PENDING (Muncy's LAD/ATH not in ATL-PHI; also a collision)", await reason(grade("Max Muncy over 0.5 hits", G1)), 'couldn\'t find "Max Muncy" in the box score');
  check("a player on another team (Adolis Garcia is PHI) in a game without PHI stays PENDING", await reason(grade("Adolis Garcia over 0.5 hits", G3)), 'couldn\'t find "Adolis Garcia" in the box score');
  check("unknown name stays PENDING", await reason(grade("Nobody Nothing over 0.5 hits", G1)), 'couldn\'t find "Nobody Nothing" in the box score');
  check("roster read failing stays PENDING", await reason(gradeMlbPlayerProp(pick("Adolis Garcia over 0.5 hits", G1), "x", { fetchBox: async () => box(G1.file), getRoster: async () => { throw new Error("db down"); } })), 'couldn\'t find "Adolis Garcia" in the box score');
  const partial = box(G1.file);
  partial.isComplete = false;
  check("partial box: absence proves nothing -> PENDING", await reason(grade("Adolis Garcia over 0.5 hits", G1, { box: partial })), 'couldn\'t find "Adolis Garcia" in the box score');
  check("partial box: a player IN the box still grades (Sale)", await grade("Chris Sale over 8.5 Ks", G1, { box: partial }), { outcome: "WIN" });
  check("empty roster: absence unprovable -> PENDING", await reason(grade("Adolis Garcia over 0.5 hits", G1, { roster: [] })), 'couldn\'t find "Adolis Garcia" in the box score');

  // ---- (f) position-aware ----------------------------------------------------
  const hitterOnK = await reason(grade("Trea Turner over 1.5 Ks", G1));
  check("hitter on a K line -> PENDING (batter strikeouts are not a market)", hitterOnK.includes("is a hitter in this box score") && hitterOnK.includes("not batter strikeouts"), true);
  check("pitcher on a hitter market -> PENDING", await reason(grade("Chris Sale over 0.5 hits", G1)), '"Chris Sale" is a pitcher in this box score, which this market doesn\'t cover');
  check("a pitcher with a zero batting line (Iglesias) is still a pitcher for hitter markets", await reason(grade("Raisel Iglesias over 0.5 hits", G1)), '"Raisel Iglesias" is a pitcher in this box score, which this market doesn\'t cover');
  check("two-way player (roster TWP) named on Ks on a day he only hit -> PUSH (did not start)", await grade("Shohei Ohtani over 5.5 Ks", G3), { outcome: "PUSH" });
  check("two-way player as a hitter grades normally (1 hit)", await grade("Shohei Ohtani over 0.5 hits", G3), { outcome: "WIN" });
  const ohtaniNoRoster = await reason(grade("Shohei Ohtani over 5.5 Ks", G3, { roster: [] }));
  check("two-way crossover needs the ROSTER to prove TWP - without it the K line stays PENDING", ohtaniNoRoster.includes("is a hitter in this box score"), true);

  // ---- guards ----------------------------------------------------------------
  check("not final -> PENDING", await reason(grade("Chris Sale over 8.5 Ks", G1, { box: box(G1.file, false) })), "the box score isn't final yet for this game");
  check("box unavailable -> PENDING", await reason(grade("Chris Sale over 8.5 Ks", G1, { box: null })), "the box score isn't available yet for this game");
  check("unrecognized market -> PENDING", await reason(grade("Chris Sale to win", G1)), "this bet text isn't a recognized MLB prop market");
  check("hits allowed is NOT graded as hits", await reason(grade("Chris Sale over 4.5 hits allowed", G1)), "this bet text isn't a recognized MLB prop market");
  check("earned runs is NOT graded as runs", await reason(grade("Chris Sale under 2.5 earned runs", G1)), "this bet text isn't a recognized MLB prop market");
  check("no line -> PENDING", await reason(grade("Chris Sale Ks", G1, { extra: { playerName: "Chris Sale", propMarket: "STRIKEOUTS" } })), "couldn't find an Over/Under line in this bet text");
  check("no name -> PENDING", await reason(grade("over 8.5 Ks", G1, { extra: { propMarket: "STRIKEOUTS" } })), "couldn't identify a player name in the bet text");

  // ---- the other postseason games extract cleanly -----------------------------
  for (const f of ["mlb-boxscore-849851-nyy-bos-wc.json", "mlb-boxscore-849843-sd-chc-wc.json"]) {
    const b = box(f);
    const starters = b.players.filter((p) => (p.pitching?.gamesStarted ?? 0) === 1);
    check(`${f}: complete, one starter per side`, [b.isComplete, starters.length], [true, 2]);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
