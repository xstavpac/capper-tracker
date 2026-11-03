#!/usr/bin/env node
// Regenerates the NCAAB cross-source name rows. A pick stores ESPN's team name ("Cleveland State
// Vikings"); a Live board card carries The Odds API's ("Cleveland St Vikings"). teamNamesMatch
// (src/lib/team-name-match.ts) folds "state" -> "st" for basketball_ncaab; this script finds the
// pairs that fold cannot reconcile ("Purdue Fort Wayne Mastodons" / "Fort Wayne Mastodons") and
// writes them as whole-name rows:
//
//   src/lib/generated/ncaab-odds-aliases.generated.ts       [ESPN name, Odds API name] rows (read at runtime)
//   src/lib/generated/ncaab-odds-participants.generated.ts  the Odds API participant list used (test fixture only)
//
//   node scripts/generate-ncaab-odds-aliases.mjs                    fetch the Odds API's /participants list
//                                                                   (needs ODDS_API_KEY in the environment or .env; the
//                                                                   endpoint is free, it uses no request credits)
//   node scripts/generate-ncaab-odds-aliases.mjs --odds-file f.json offline: a saved copy of that response
//
// ESPN side: the committed college-teams.generated.ts (itself generated from ESPN group 50), so the
// two lists are always compared at the same snapshot. Rerun after generate-college-teams.mjs, or when
// the Odds API renames a team, then review the diff.
//
// Pairing: after the fold, an ESPN name with no identical Odds API name is paired with the one still
// unmatched Odds API name that shares its first AND last word ("American University Eagles" /
// "American Eagles"). Anything that rule cannot settle is in OVERRIDES below, read off the two lists
// by hand and re-checked on every run. The script exits non-zero when a name is left unpaired that is
// not in NO_ODDS_TWIN, or when a row would make two different schools match (the same check the
// acceptance test makes), so a bad pairing cannot be committed silently.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEAMS = resolve(ROOT, "src/lib/generated/college-teams.generated.ts");
const OUT_ALIASES = resolve(ROOT, "src/lib/generated/ncaab-odds-aliases.generated.ts");
const OUT_PARTICIPANTS = resolve(ROOT, "src/lib/generated/ncaab-odds-participants.generated.ts");

// ESPN name -> Odds API name, for the pairs the first-and-last-word rule cannot decide.
const OVERRIDES = new Map([
  ["App State Mountaineers", "Appalachian St Mountaineers"],
  ["Boston University Terriers", "Boston Univ. Terriers"],
  ["California Baptist Lancers", "Cal Baptist Lancers"],
  ["Cal State Bakersfield Roadrunners", "CSU Bakersfield Roadrunners"],
  ["Cal State Fullerton Titans", "CSU Fullerton Titans"],
  ["Cal State Northridge Matadors", "CSU Northridge Matadors"],
  ["Central Connecticut Blue Devils", "Central Connecticut St Blue Devils"],
  ["Florida International Panthers", "Florida Int'l Golden Panthers"],
  ["George Washington Revolutionaries", "GW Revolutionaries"],
  ["Grambling Tigers", "Grambling St Tigers"],
  ["Grand Canyon Lopes", "Grand Canyon Antelopes"],
  ["IU Indianapolis Jaguars", "IUPUI Jaguars"],
  ["Kansas City Roos", "UMKC Kangaroos"],
  ["Little Rock Trojans", "Arkansas-Little Rock Trojans"],
  ["Long Beach State Beach", "Long Beach St 49ers"],
  ["Long Island University Sharks", "LIU Sharks"],
  ["Loyola Chicago Ramblers", "Loyola (Chi) Ramblers"],
  ["Loyola Maryland Greyhounds", "Loyola (MD) Greyhounds"],
  ["LSU New Orleans Privateers", "New Orleans Privateers"],
  ["Maryland Eastern Shore Hawks", "Maryland-Eastern Shore Hawks"],
  ["Mississippi Valley State Delta Devils", "Miss Valley St Delta Devils"],
  ["Mount St. Mary's Mountaineers", "Mt. St. Mary's Mountaineers"],
  ["Nicholls Colonels", "Nicholls St Colonels"],
  ["Northern Colorado Bears", "N Colorado Bears"],
  ["Prairie View A&M Panthers", "Prairie View Panthers"],
  ["Purdue Fort Wayne Mastodons", "Fort Wayne Mastodons"],
  ["Sam Houston Bearkats", "Sam Houston St Bearkats"],
  ["Seattle U Redhawks", "Seattle Redhawks"],
  ["Southeast Missouri State Redhawks", "SE Missouri St Redhawks"],
  ["SIU Edwardsville Cougars", "SIU-Edwardsville Cougars"],
  ["St. Thomas Tommies", "St. Thomas (MN) Tommies"],
  ["UAlbany Great Danes", "Albany Great Danes"],
  ["UT Arlington Mavericks", "UT-Arlington Mavericks"],
  ["UT Martin Skyhawks", "Tenn-Martin Skyhawks"],
]);

// ESPN D1 programs the Odds API has no basketball team for. Listed so an unexpected gap still fails.
const NO_ODDS_TWIN = new Set(["West Florida Argonauts"]);

// Same rules as team-name-match.ts normalizeTeamName + foldNcaabState (kept in step by the acceptance test).
const norm = (n) => n.normalize("NFD").replace(/\p{M}/gu, "").replace(/\./g, "").replace(/\s+/g, " ").trim().toLowerCase();
const fold = (n) => norm(n).replace(/\bstate\b/g, "st");

function argValue(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function apiKey() {
  if (process.env.ODDS_API_KEY) return process.env.ODDS_API_KEY;
  const envPath = resolve(ROOT, ".env");
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^ODDS_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, "");
  }
  throw new Error("ODDS_API_KEY is not set (environment or .env); or pass --odds-file");
}

async function loadParticipants() {
  const file = argValue("odds-file");
  const body = file
    ? JSON.parse(readFileSync(resolve(file), "utf8"))
    : await (async () => {
        const res = await fetch(`https://api.the-odds-api.com/v4/sports/basketball_ncaab/participants?apiKey=${apiKey()}`);
        if (!res.ok) throw new Error(`Odds API participants: ${res.status}`);
        return res.json();
      })();
  const names = body.map((p) => p.full_name);
  if (names.length < 300) throw new Error(`only ${names.length} participants - a partial response`);
  return names.sort((a, b) => a.localeCompare(b));
}

const src = readFileSync(TEAMS, "utf8");
const espn = [...src.matchAll(/\{ id: "\d+", name: "([^"]+)"/g)].map((m) => m[1]);
if (espn.length < 300) throw new Error(`parsed only ${espn.length} ESPN teams from ${TEAMS}`);
const odds = await loadParticipants();

const oddsFolded = new Set(odds.map(fold));
const espnFolded = new Set(espn.map(fold));
const unmatchedEspn = espn.filter((n) => !oddsFolded.has(fold(n)));
const unmatchedOdds = odds.filter((n) => !espnFolded.has(fold(n)));

const firstLast = (n) => {
  const w = fold(n).split(" ");
  return [w[0], w[w.length - 1]];
};

const rows = [];
const problems = [];
const claimed = new Set();
for (const e of unmatchedEspn) {
  let o = OVERRIDES.get(e);
  if (o !== undefined && !odds.includes(o)) {
    problems.push(`override target is not an Odds API name: ${e} -> ${o}`);
    continue;
  }
  if (o === undefined) {
    const [f, l] = firstLast(e);
    const c = unmatchedOdds.filter((x) => { const [xf, xl] = firstLast(x); return xf === f && xl === l; });
    if (c.length === 1) o = c[0];
    else if (NO_ODDS_TWIN.has(e)) continue;
    else {
      problems.push(`no pairing for "${e}" (${c.length} first-and-last-word candidates: ${c.join(" | ") || "none"})`);
      continue;
    }
  }
  if (claimed.has(o)) problems.push(`Odds API name paired twice: ${o}`);
  claimed.add(o);
  rows.push([e, o]);
}
for (const [e] of OVERRIDES) if (!unmatchedEspn.includes(e)) problems.push(`override no longer needed (fold or names changed): ${e}`);
for (const e of NO_ODDS_TWIN) if (!unmatchedEspn.includes(e)) problems.push(`NO_ODDS_TWIN entry no longer unmatched: ${e}`);

// No false merge: after the rows, each canonical form belongs to exactly one ESPN school.
const aliasOf = new Map(rows.map(([e, o]) => [fold(e), fold(o)]));
const canon = (n) => aliasOf.get(fold(n)) ?? fold(n);
const seen = new Map();
for (const e of espn) {
  const c = canon(e);
  if (seen.has(c)) problems.push(`false merge: "${seen.get(c)}" and "${e}" both canon to "${c}"`);
  seen.set(c, e);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

rows.sort((a, b) => a[0].localeCompare(b[0]));
const q = (s) => JSON.stringify(s);
writeFileSync(
  OUT_ALIASES,
  `// GENERATED by scripts/generate-ncaab-odds-aliases.mjs. Do not edit by hand: rerun it.
// [ESPN name (stored on picks), The Odds API name (Live board cards)] for every D1 team whose two
// spellings differ by more than "State" -> "St" (teamNamesMatch folds that itself).
export const NCAAB_ODDS_ALIAS_ROWS: readonly (readonly [string, string])[] = [
${rows.map(([e, o]) => `  [${q(e)}, ${q(o)}],`).join("\n")}
];
`
);
writeFileSync(
  OUT_PARTICIPANTS,
  `// GENERATED by scripts/generate-ncaab-odds-aliases.mjs. Do not edit by hand: rerun it.
// The Odds API's basketball_ncaab /participants list the alias rows were generated against.
// Test fixture only: nothing at runtime imports this.
export const NCAAB_ODDS_PARTICIPANTS: readonly string[] = [
${odds.map((n) => `  ${q(n)},`).join("\n")}
];
`
);
console.log(`ESPN ${espn.length}, Odds API ${odds.length}; ${rows.length} alias rows written; ${unmatchedEspn.length - rows.length} ESPN names with no Odds API twin.`);
