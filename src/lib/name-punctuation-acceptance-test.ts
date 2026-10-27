// Proof for player names written with (or without) punctuation, and for the NBA combo-market
// spellings - run with:
//   npx tsx src/lib/name-punctuation-acceptance-test.ts
// No network, no database. NBA / NHL rosters are the 2026-10-13 fixtures the NBA name tests use.
//
//   PART A - typographic apostrophes / dashes are made straight once at the parseCatalog entry
//            ("De’Aaron Fox" was "doesn't look like a player's name").
//   PART B - a multi-word typed name that is exactly a roster surname uses the surname tier
//            ("Gilgeous Alexander"); a first name + a surname that missed is still a miss; shared
//            surnames still ask. The stored pick text takes the roster's spelling.
//   PART C - MLB: hyphen / apostrophe written as a space, or not at all, is the same name; two
//            players can't collapse onto one key.
//   PART D - key collisions across the real rosters (NBA, NHL, NFL, MLB fixtures).
//   PART E - NBA combo markets in every spelling a capper uses (parse + import).
import fs from "node:fs";
import path from "node:path";
import { parseCatalog, parseSupportedNbaProp, normalizeTypography } from "./parse-catalog";
import { recoverUnresolvedLines } from "./recover-unresolved-lines";
import { describeUnresolvedLines } from "./bulk-import-summary";
import { parseNbaProp } from "./nba-prop";
import { parsePlayerProp } from "./bet-line";
import { resolveNameAgainstRoster, resolvePlayerPropAgainstRoster } from "./player-roster-fallback";
import { matchMlbName, mlbNameKey } from "./mlb-name-match";
import { normalizeName, foldDiacritics } from "./fuzzy-match";
import { extractMlbRosterPlayers, MLB_TEAM_IDS } from "../server/data/mlb-roster";
import { extractRosterPlayers } from "../server/data/nfl-roster";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const fx = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(__dirname, "../server/data/__fixtures__", name), "utf8"));
const NBA = fx("nba-league-roster-2026-10-13.json") as RosterPlayer[];
const NHL = fx("nhl-league-roster-2026-10-13.json") as RosterPlayer[];
const teamOf = (name: string) => NBA.find((p) => p.playerName === name)?.team.toLowerCase();
const player = (playerName: string, lastName: string, team: string, position: string, id: string): RosterPlayer => ({
  playerName,
  firstName: playerName.split(" ")[0],
  lastName,
  team,
  position,
  externalPlayerId: id,
});

type Outcome = { sport?: string; betType?: string; team?: string[]; description?: string; asks?: string[]; unresolved?: string | null; dropped?: true };
// One pasted line through the real import, read the way the import screen reads it.
function importLine(line: string, nbaRoster: RosterPlayer[] = NBA, nflRoster: RosterPlayer[] = []): Outcome {
  const parsed = parseCatalog(`Cap\n${line}`, []);
  const rec = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, [], nflRoster, parsed.picks, NHL, [], [], nbaRoster, parsed.unresolvedLeagues);
  const pick = parsed.picks[0] ?? rec.recovered[0];
  if (pick?.ambiguous) return { asks: pick.ambiguous.map((o) => o.label), betType: pick.betType };
  if (pick) return { sport: pick.sportName, betType: pick.betType, team: pick.teamNicknames, description: pick.description };
  if (rec.stillUnresolved.length) return { unresolved: describeUnresolvedLines(rec.stillUnresolved, rec.reasons)[0].reason };
  return { dropped: true };
}

console.log("########## PART A: typographic punctuation ##########");
{
  check("curly apostrophes (’ ‘ ʼ ´ `) become '", normalizeTypography("De’Aaron D‘Andre Ja’Marr Ke´Bryan De`Aaron Dʼangelo"), "De'Aaron D'Andre Ja'Marr Ke'Bryan De'Aaron D'angelo");
  check("en / em / non-breaking dashes become -", normalizeTypography("Gilgeous–Alexander Caldwell—Pope Karl‑Anthony"), "Gilgeous-Alexander Caldwell-Pope Karl-Anthony");
  check("plain text is untouched", normalizeTypography("De'Aaron Fox over 26.5 points (-115) 2u"), "De'Aaron Fox over 26.5 points (-115) 2u");
  for (const line of [
    "De’Aaron Fox over 26.5 PRA",
    "De‘Aaron Fox over 26.5 points + rebounds + assists",
    "De’Aaron Fox over 5.5 assists",
    "Shai Gilgeous–Alexander over 30.5 points",
    "Karl‑Anthony Towns over 22.5 rebounds",
    "Kentavious Caldwell—Pope over 1.5 threes",
  ]) {
    const got = importLine(line);
    check(`imports as NBA: ${line}`, got.sport === "NBA" && got.betType === "PLAYER_PROP" && (got.team ?? []).length === 1, true);
  }
  check("De’Aaron Fox is the Spurs player, not Adam Fox (NHL)", importLine("De’Aaron Fox over 26.5 PRA").team, [teamOf("De'Aaron Fox")]);
  // The straight and the typographic spelling land on the same pick.
  check("curly = straight", importLine("De’Aaron Fox over 6.5 assists"), importLine("De'Aaron Fox over 6.5 assists"));
  // NFL: the pasted text reaches the NFL parser straight.
  const nfl = parseCatalog("Cap\nJa’Marr Chase over 80.5 receiving yards", []);
  check("an NFL apostrophe name reaches the parser straight", nfl.unresolved.concat(nfl.picks.map((p) => p.description)).some((l) => l.includes("Ja'Marr Chase")), true);
  const chase = player("Ja'Marr Chase", "Chase", "Cincinnati Bengals", "WR", "4362628");
  const swift = player("D'Andre Swift", "Swift", "Chicago Bears", "RB", "4259545");
  for (const [typed, want] of [["Ja’Marr Chase", chase], ["JaMarr Chase", chase], ["Ja Marr Chase", chase], ["D'Andre Swift", swift], ["DAndre Swift", swift], ["D Andre Swift", swift]] as const) {
    const r = resolvePlayerPropAgainstRoster(`${typed} over 60.5 rushing yards`, [chase, swift], undefined, "NFL");
    check(`NFL roster: ${typed}`, r.status === "resolved" ? r.playerName : r.status, want.playerName);
  }
}

console.log("\n########## PART B: a multi-word surname ##########");
{
  const sga = resolveNameAgainstRoster("Gilgeous Alexander", NBA, undefined, "NBA");
  check("'Gilgeous Alexander' is the surname of Shai Gilgeous-Alexander", sga.status === "resolved" ? [sga.playerName, sga.via] : sga.status, ["Shai Gilgeous-Alexander", "surname"]);
  for (const typed of ["Gilgeous-Alexander", "GilgeousAlexander", "gilgeous alexander"]) {
    const r = resolveNameAgainstRoster(typed, NBA, undefined, "NBA");
    check(`'${typed}' alone resolves`, r.status === "resolved" ? r.playerName : r.status, "Shai Gilgeous-Alexander");
  }
  check("'Caldwell Pope' alone resolves", (resolveNameAgainstRoster("Caldwell Pope", NBA, undefined, "NBA") as { playerName?: string }).playerName, "Kentavious Caldwell-Pope");
  // A first name + a surname that missed is a real miss, not a surname.
  check("'Derek White' (a misspelling of Derrick White) stays unresolved", resolveNameAgainstRoster("Derek White", NBA, undefined, "NBA").status, "unresolved");
  check("'Zzz Alexander' stays unresolved", resolveNameAgainstRoster("Zzz Alexander", NBA, undefined, "NBA").status, "unresolved");
  check("a full name still resolves by the exact tier", (resolveNameAgainstRoster("Jaren Jackson", NBA, undefined, "NBA") as { via?: string }).via, "exact");
  // Shared multi-word surnames still ask - never guessed.
  const pair = [player("Ann Smith-Jones", "Smith-Jones", "A", "G", "1"), player("Bob Smith-Jones", "Smith-Jones", "B", "F", "2")];
  const shared = resolveNameAgainstRoster("Smith Jones", pair, undefined, "NBA");
  check("a shared hyphenated surname is ambiguous (surname tier)", shared.status === "ambiguous" ? [shared.tier, shared.matches.length] : shared.status, ["surname", 2]);
  // NFL: the same tier, e.g. Amon-Ra St. Brown typed "St Brown".
  const stBrown = player("Amon-Ra St. Brown", "St. Brown", "Detroit Lions", "WR", "4036378");
  check("NFL 'St Brown' resolves to Amon-Ra St. Brown", (resolveNameAgainstRoster("St Brown", [stBrown], undefined, "NFL") as { playerName?: string }).playerName, "Amon-Ra St. Brown");

  // End to end: the stored pick text takes the roster's name, so the grader reads the player.
  const sgaPick = importLine("Gilgeous-Alexander over 30.5 points");
  check("import: team is OKC", sgaPick.team, [teamOf("Shai Gilgeous-Alexander")]);
  check("import: description names Shai Gilgeous-Alexander", sgaPick.description, "Shai Gilgeous-Alexander over 30.5 points");
  const jokic = importLine("Jokic o10.5 reb");
  check("a one-word surname keeps the capper's text (unchanged)", jokic.description, "Jokic o10.5 reb");
}

console.log("\n########## PART C: MLB keys ##########");
{
  const mlb = [
    { id: "1", n: "Ha-Seong Kim" },
    { id: "2", n: "Ke'Bryan Hayes" },
    { id: "3", n: "Travis d'Arnaud" },
    { id: "4", n: "Max Muncy" },
    { id: "5", n: "Max Muncy" },
  ];
  const find = (typed: string) => matchMlbName(typed, mlb, (p) => p.id, (p) => p.n);
  for (const typed of ["Ha-Seong Kim", "Ha Seong Kim", "HaSeong Kim", "ha–seong kim"]) check(`'${typed}' -> Ha-Seong Kim`, find(typed.replace("–", "-")).status === "one" && (find(typed.replace("–", "-")) as { item: { n: string } }).item.n, "Ha-Seong Kim");
  for (const typed of ["Ke'Bryan Hayes", "KeBryan Hayes", "Ke Bryan Hayes"]) check(`'${typed}' -> Ke'Bryan Hayes`, (find(typed) as { item?: { n: string } }).item?.n, "Ke'Bryan Hayes");
  for (const typed of ["Travis d'Arnaud", "Travis dArnaud", "Travis d Arnaud"]) check(`'${typed}' -> Travis d'Arnaud`, (find(typed) as { item?: { n: string } }).item?.n, "Travis d'Arnaud");
  check("two real Max Muncys stay 'many'", find("Max Muncy").status, "many");
  // Different players that collapse onto one key are never settled on their own.
  const clash = [{ id: "1", n: "Jo Ann Smith" }, { id: "2", n: "Joann Smith" }];
  check("two different players on one collapsed key are 'many'", matchMlbName("Joann Smith", clash, (p) => p.id, (p) => p.n).status, "many");
  check("a different first name is still no match", find("Zach Kim").status, "none");
}

console.log("\n########## PART D: key collisions in the real rosters ##########");
{
  const mlbRaw = fx("mlb-roster-sample.json") as Record<string, unknown>;
  const MLB = Object.entries(mlbRaw).flatMap(([id, resp]) => extractMlbRosterPlayers(MLB_TEAM_IDS.find(([t]) => t === id)![1], resp));
  const NFL = ["den", "det", "ind", "kc"].flatMap((t) => extractRosterPlayers(t.toUpperCase(), fx(`nfl-roster-${t}.json`)));
  // Two DIFFERENT spellings (or players) on one key would be settled by the exact tier as one player.
  const collisions = (label: string, roster: RosterPlayer[], key: (n: string) => string) => {
    const byKey = new Map<string, Set<string>>();
    for (const p of roster) {
      const k = key(p.playerName);
      const ids = byKey.get(k) ?? new Set<string>();
      ids.add(p.externalPlayerId);
      byKey.set(k, ids);
    }
    const clashes = [...byKey.entries()].filter(([, ids]) => ids.size > 1).map(([k]) => k);
    // A name two real players share (Max Muncy) is the existing "ambiguous / many" path - listed, not hidden.
    check(`${label}: ${roster.length} players, ${clashes.length} shared keys (existing ambiguity path)`, clashes.length <= 2, true);
    return clashes;
  };
  collisions("NBA", NBA, (n) => normalizeName(foldDiacritics(n)));
  collisions("NHL", NHL, (n) => normalizeName(foldDiacritics(n)));
  collisions("NFL (4 teams)", NFL, (n) => normalizeName(foldDiacritics(n)));
  const mlbClashes = collisions("MLB (collapsed)", MLB, (n) => mlbNameKey(n).replace(/ /g, ""));
  // Collapsing the spaces adds no clash: the shared keys are exactly the ones the spaced key already had (the two Max Muncys; José Fermin / José Fermín, one accent apart - both the existing "many" path).
  const spacedClashes = collisions("MLB (spaced, as before)", MLB, (n) => mlbNameKey(n));
  check("MLB: the collapsed key clashes on exactly the same players as the spaced key", mlbClashes.map((k) => k).sort(), spacedClashes.map((k) => k.replace(/ /g, "")).sort());
  check("NBA: no two players share a normalized key", collisions("NBA again", NBA, (n) => normalizeName(foldDiacritics(n))), []);
}

console.log("\n########## PART E: NBA combo markets ##########");
{
  const market = (line: string) => parseNbaProp(line)?.propMarket ?? null;
  const spellings: [string, string][] = [
    ["points + rebounds + assists", "POINTS_REBOUNDS_ASSISTS"],
    ["points rebounds assists", "POINTS_REBOUNDS_ASSISTS"],
    ["points, rebounds, assists", "POINTS_REBOUNDS_ASSISTS"],
    ["points, rebounds & assists", "POINTS_REBOUNDS_ASSISTS"],
    ["points/rebounds/assists", "POINTS_REBOUNDS_ASSISTS"],
    ["PRA", "POINTS_REBOUNDS_ASSISTS"],
    ["pra", "POINTS_REBOUNDS_ASSISTS"],
    ["P+R+A", "POINTS_REBOUNDS_ASSISTS"],
    ["P/R/A", "POINTS_REBOUNDS_ASSISTS"],
    ["pts+reb+ast", "POINTS_REBOUNDS_ASSISTS"],
    ["pts + reb + ast", "POINTS_REBOUNDS_ASSISTS"],
    ["pts/reb/ast", "POINTS_REBOUNDS_ASSISTS"],
    ["pts, reb, ast", "POINTS_REBOUNDS_ASSISTS"],
    ["pts reb ast", "POINTS_REBOUNDS_ASSISTS"],
    ["PR", "POINTS_REBOUNDS"],
    ["points + rebounds", "POINTS_REBOUNDS"],
    ["pts+reb", "POINTS_REBOUNDS"],
    ["P+R", "POINTS_REBOUNDS"],
    ["PA", "POINTS_ASSISTS"],
    ["points + assists", "POINTS_ASSISTS"],
    ["pts/ast", "POINTS_ASSISTS"],
    ["P+A", "POINTS_ASSISTS"],
    ["RA", "REBOUNDS_ASSISTS"],
    ["rebounds + assists", "REBOUNDS_ASSISTS"],
    ["reb+ast", "REBOUNDS_ASSISTS"],
    ["R+A", "REBOUNDS_ASSISTS"],
  ];
  for (const [spelling, want] of spellings) {
    check(`'De'Aaron Fox over 26.5 ${spelling}' -> ${want}`, market(`De'Aaron Fox over 26.5 ${spelling}`), want);
  }
  check("the player name survives the market words", parseNbaProp("De'Aaron Fox over 26.5 points + rebounds + assists")?.playerName, "De'Aaron Fox");
  for (const [suffix, want] of [["PRA", "POINTS_REBOUNDS_ASSISTS"], ["PR", "POINTS_REBOUNDS"], ["PA", "POINTS_ASSISTS"], ["RA", "REBOUNDS_ASSISTS"]] as const) {
    const line = `De'Aaron Fox over 26.5 ${suffix}`;
    const got = importLine(line);
    check(`import: ${line}`, [got.sport, got.betType, got.team], ["NBA", "PLAYER_PROP", [teamOf("De'Aaron Fox")]]);
    check(`supported NBA prop: ${line}`, parseSupportedNbaProp(line)?.prop.propMarket, want);
  }
  // A short form is NBA-only: it never reads as an NFL prop.
  check("'PR' / 'PA' / 'RA' are not NFL props", ["PR", "PA", "RA"].map((s) => parsePlayerProp(`Fox over 26.5 ${s}`)), [null, null, null]);
  // The long form with a curly-apostrophe name (the line that failed).
  const longForm = importLine("De’Aaron Fox over 26.5 points + rebounds + assists");
  check("the long form with a curly apostrophe imports", [longForm.sport, longForm.team], ["NBA", [teamOf("De'Aaron Fox")]]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
