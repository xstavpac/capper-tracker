// MLB roster extraction, name matching and catalog-import recovery, against REAL 40-man rosters
// (mlb-roster-sample.json: 14 teams, fetched 2026-09-30 - see scripts/capture-mlb-fixtures.mjs). Pure (no
// DB, no network). Run with:
//   npx tsx src/lib/mlb-roster-recovery-acceptance-test.ts
//
// Pins: roster extraction (use-name first names, every position kept, ids as strings); the name matcher's
// tiers (accent folding, middle initials, first-name short forms, bare surnames) and its refusal to guess
// a collision (TWO real Max Muncys, TWO real Jose Fermins); position-aware resolution; team-context-only
// tie-breaking; the cross-sport guard for "hits"; and the recovery pass wiring.
import fs from "node:fs";
import path from "node:path";
import { extractMlbRosterPlayers, MLB_TEAM_IDS } from "@/server/data/mlb-roster";
import { matchMlbName, mlbNameKey, mlbNameTokens } from "@/lib/mlb-name-match";
import { resolveMlbPropAgainstRoster } from "@/lib/mlb-roster-fallback";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { parseCatalog } from "@/lib/parse-catalog";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "server", "data", "__fixtures__", "mlb-roster-sample.json"), "utf8")) as Record<string, unknown>;
const roster: RosterPlayer[] = Object.entries(raw).flatMap(([id, resp]) => extractMlbRosterPlayers(MLB_TEAM_IDS.find(([t]) => t === id)![1], resp));
const byName = (n: string) => roster.filter((p) => p.playerName === n);

// ---- extraction ------------------------------------------------------------------------------------------------
check("30 franchises, unique ids and names", [MLB_TEAM_IDS.length, new Set(MLB_TEAM_IDS.map((t) => t[0])).size, new Set(MLB_TEAM_IDS.map((t) => t[1])).size], [30, 30, 30]);
check("14 sampled teams loaded", [...new Set(roster.map((p) => p.team))].length, 14);
check("every player has a string id, names and a position", roster.every((p) => /^\d+$/.test(p.externalPlayerId) && p.playerName && p.firstName && p.lastName && p.position), true);
check("ids are unique within the sample (one current team per player)", new Set(roster.map((p) => p.externalPlayerId)).size, roster.length);
check("positions include pitchers, hitters and the two-way player", ["P", "C", "SS", "DH", "TWP"].every((pos) => roster.some((p) => p.position === pos)), true);
const cook = byName("Alex Cook")[0];
check("use-name first name is stored (Alexander -> Alex), as the box score shows it", [cook.firstName, cook.lastName, cook.position, cook.team], ["Alex", "Cook", "P", "Tampa Bay Rays"]);
check("Ohtani is TWP on the Dodgers", byName("Shohei Ohtani").map((p) => [p.team, p.position]), [["Los Angeles Dodgers", "TWP"]]);
check("two real Max Muncys exist (Dodgers + Athletics)", byName("Max Muncy").map((p) => p.team).sort(), ["Athletics", "Los Angeles Dodgers"]);
check("a malformed / empty response yields []", [extractMlbRosterPlayers("X", null), extractMlbRosterPlayers("X", {}), extractMlbRosterPlayers("X", { roster: "no" })], [[], [], []]);
check("an entry missing a position is skipped", extractMlbRosterPlayers("X", { roster: [{ person: { id: 1, fullName: "A B", firstName: "A", lastName: "B" }, position: {} }] }), []);

// ---- name tokens / keys ------------------------------------------------------------------------------------------------
check("accents fold, middle initial dropped: José A. Ferrer", mlbNameKey("José A. Ferrer"), "jose ferrer");
check("suffix dropped: Bobby Witt Jr.", mlbNameTokens("Bobby Witt Jr."), ["bobby", "witt"]);
check("apostrophes/periods: Ke'Bryan Hayes / J.T. Realmuto", [mlbNameKey("Ke'Bryan Hayes"), mlbNameKey("J.T. Realmuto")], ["kebryan hayes", "jt realmuto"]);

// ---- the matcher -----------------------------------------------------------------------------------------------------
const m = (typed: string, pool: RosterPlayer[] = roster) => {
  const r = matchMlbName(typed, pool, (p) => p.externalPlayerId, (p) => p.playerName);
  return r.status === "one" ? ["one", r.item.playerName, r.item.team] : [r.status];
};
check("exact", m("Shohei Ohtani"), ["one", "Shohei Ohtani", "Los Angeles Dodgers"]);
check("accent-free typed vs accented roster: Jose Ferrer -> Jose A. Ferrer (middle initial + accent)", m("Jose Ferrer"), ["one", "José A. Ferrer", "Seattle Mariners"]);
check("accented typed: Jesús Luzardo style -> accent-free", m("José Ferrer"), ["one", "José A. Ferrer", "Seattle Mariners"]);
check("first-name short form: Alexander Cook -> Alex Cook", m("Alexander Cook"), ["one", "Alex Cook", "Tampa Bay Rays"]);
check("first-name short form the other way: Alex Cook", m("Alex Cook"), ["one", "Alex Cook", "Tampa Bay Rays"]);
check("a nickname that is NOT a prefix is not guessed (Mike vs Michael stays unmatched)", matchMlbName("Mike Schmidt", [{ id: "1", n: "Michael Schmidt" }], (p) => p.id, (p) => p.n, { allowFuzzy: false }).status, "none");
check("TWO real Max Muncys -> many, never guessed", m("Max Muncy")[0], "many");
check("TWO real Jose Fermins (Angels + Cardinals; accent only differs) -> many", m("Jose Fermin")[0], "many");
check("bare surname, unique in the pool", m("Ohtani"), ["one", "Shohei Ohtani", "Los Angeles Dodgers"]);
check("bare surname collision (Muncy) -> many", m("Muncy")[0], "many");
check("no match", m("Nobody Nothing"), ["none"]);
check("typo tolerated (one edit) by the fuzzy tier", m("Shohei Ohtanni"), ["one", "Shohei Ohtani", "Los Angeles Dodgers"]);
check("a different first name with the same surname is NOT matched (Zack Muncy)", m("Zack Muncy"), ["none"]);

// ---- position-aware resolution -------------------------------------------------------------------------------------------
const res = (line: string, relevant: string[] = [], paste: string[] = [], other: RosterPlayer[][] = []) => {
  const r = resolveMlbPropAgainstRoster(line, roster, relevant, paste, other);
  return r.status === "resolved" ? ["resolved", r.playerName, r.team] : r.status === "ambiguous" ? ["ambiguous", r.matches.map((x) => x.team).sort()] : ["unresolved"];
};
check("pitcher K line resolves a pitcher (Chris Sale)", res("Chris Sale over 5.5 Ks"), ["resolved", "Chris Sale", "Atlanta Braves"]);
check("pitcher K line: bare surname resolves the pitcher (Luzardo)", res("Luzardo o5.5 K"), ["resolved", "Jesús Luzardo", "Philadelphia Phillies"]);
check("a HITTER on a K line never resolves (batter strikeouts are not a market)", res("Trea Turner over 1.5 Ks"), ["unresolved"]);
check("a PITCHER on a hitter market never resolves (Sale over 0.5 hits)", res("Chris Sale over 0.5 hits"), ["unresolved"]);
check("two-way player resolves on both sides (TWP fits pitcher and hitter markets)", [res("Shohei Ohtani over 5.5 Ks"), res("Shohei Ohtani 1+ hits")], [["resolved", "Shohei Ohtani", "Los Angeles Dodgers"], ["resolved", "Shohei Ohtani", "Los Angeles Dodgers"]]);
check("hitter market resolves a hitter (Jeremy Pena)", res("Jeremy Pena 1+ hits"), ["resolved", "Jeremy Peña", "Houston Astros"]);
check("accent-free typed + every market shape resolves (Velazquez TB / HR / RBI)", ["Nelson Velazquez o3.5 TB", "Nelson Velazquez to hit a home run", "Nelson Velazquez 2+ RBI"].map((l) => res(l)[0]), ["resolved", "resolved", "resolved"]);

// ---- collisions need team context, and only what the capper/board actually supplied --------------------------------
check("Max Muncy with no context -> ambiguous (never guessed)", res("Max Muncy 1+ hits"), ["ambiguous", ["Athletics", "Los Angeles Dodgers"]]);
check("bare 'Muncy' with no context -> ambiguous", res("Muncy over 0.5 walks")[0], "ambiguous");
check("paste context (the capper named the Dodgers elsewhere in the paste) breaks the tie", res("Max Muncy 1+ hits", [], ["dodgers"]), ["resolved", "Max Muncy", "Los Angeles Dodgers"]);
check("paste context with the Athletics picks the Athletics' Muncy", res("Max Muncy 1+ hits", [], ["athletics"]), ["resolved", "Max Muncy", "Athletics"]);
check("the live slate breaks the tie when only ONE Muncy's team plays", res("Max Muncy 1+ hits", ["Athletics", "Houston Astros"]), ["resolved", "Max Muncy", "Athletics"]);
check("the live slate does NOT break it when both teams play", res("Max Muncy 1+ hits", ["Athletics", "Los Angeles Dodgers"]), ["ambiguous", ["Athletics", "Los Angeles Dodgers"]]);
check("paste context naming neither Muncy's team leaves it ambiguous", res("Max Muncy 1+ hits", [], ["astros"])[0], "ambiguous");
check("Jose Fermin: two real players (Angels P, Cardinals LF) - the market's position picks the one that fits", [res("Jose Fermin over 0.5 Ks"), res("Jose Fermin 1+ hits")], [["resolved", "José Fermin", "Los Angeles Angels"], ["resolved", "José Fermín", "St. Louis Cardinals"]]);

// ---- cross-sport guard: bare hits/runs need roster evidence, and a name in another sport's roster is unsafe ----------------
const nhlLike: RosterPlayer[] = [{ playerName: "Jeremy Pena", firstName: "Jeremy", lastName: "Pena", team: "Pittsburgh Penguins", position: "C", externalPlayerId: "nhl-1" }];
check("hits: a name that ALSO matches the NHL roster is ambiguous between sports", res("Jeremy Pena 1+ hits", [], [], [nhlLike]), ["ambiguous", ["Houston Astros"]]);
check("runs: same guard", res("Jeremy Pena over 0.5 runs", [], [], [nhlLike])[0], "ambiguous");
check("unambiguous MLB vocabulary (total bases) is not blocked by another sport's roster", res("Jeremy Pena o1.5 TB", [], [], [nhlLike]), ["resolved", "Jeremy Peña", "Houston Astros"]);
check("hits with a name only MLB has resolves", res("Jeremy Pena 1+ hits", [], [], [[]]), ["resolved", "Jeremy Peña", "Houston Astros"]);
check("a non-MLB line is unresolved", res("Josh Allen over 275.5 passing yards"), ["unresolved"]);

// ---- the recovery pass ------------------------------------------------------------------------------------------------------
{
  const paste = ["Krash", "Chris Sale over 5.5 Ks", "Max Muncy 1+ hits", "Jeremy Pena 1+ hits", "Trea Turner over 1.5 Ks", "Hoop Dealer", "Skenes o17.5 outs"].join("\n");
  const parsed = parseCatalog(paste);
  check("parse: all six sport-less MLB lines wait for recovery, attributed by header", [parsed.picks.length, parsed.unresolved, parsed.unresolvedCapperNames], [
    0,
    ["Chris Sale over 5.5 Ks", "Max Muncy 1+ hits", "Jeremy Pena 1+ hits", "Trea Turner over 1.5 Ks", "Skenes o17.5 outs"],
    ["Krash", "Krash", "Krash", "Krash", "Hoop Dealer"],
  ]);
  const out = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, [], [], parsed.picks, [], roster);
  check(
    "recovered: sport MLB, PLAYER_PROP, team nickname from the roster hit, N+ normalized, capper kept",
    out.recovered.map((p) => [p.capperName, p.sportName, p.betType, p.description, p.teamNicknames]),
    [
      ["Krash", "MLB", "PLAYER_PROP", "Chris Sale over 5.5 Ks", ["atlanta braves"]],
      ["Krash", "MLB", "PLAYER_PROP", "Jeremy Pena Over 0.5 hits", ["houston astros"]],
    ]
  );
  check("still unresolved: the Muncy collision, the hitter-on-a-K line, and the pitcher not in the sampled teams", out.stillUnresolved, ["Max Muncy 1+ hits", "Trea Turner over 1.5 Ks", "Skenes o17.5 outs"]);

  // Paste context: a Dodgers pick elsewhere in the paste resolves Muncy.
  const ctx = parseCatalog(["Krash", "MLB Dodgers ML", "Max Muncy 1+ hits"].join("\n"));
  const out2 = recoverUnresolvedLines(ctx.unresolved, ctx.unresolvedCapperNames, [], [], ctx.picks, [], roster);
  check("paste-local team mention (Dodgers ML in the same paste) resolves the Muncy collision", out2.recovered.map((p) => [p.sportName, p.teamNicknames]), [["MLB", ["los angeles dodgers"]]]);

  // No MLB roster (table empty / read failed): lines stay unresolved exactly as before MLB props existed.
  const out3 = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, [], [], parsed.picks, [], []);
  check("empty MLB roster -> everything stays unresolved", [out3.recovered.length, out3.stillUnresolved.length], [0, 5]);

  // Cross-sport through the recovery pass: a name in the NHL roster blocks a bare "hits" line.
  const hits = parseCatalog(["Krash", "Jeremy Pena 1+ hits"].join("\n"));
  const out4 = recoverUnresolvedLines(hits.unresolved, hits.unresolvedCapperNames, [], [], hits.picks, nhlLike, roster);
  check("recovery: NHL roster hit on the same name blocks a sport-less 'hits' line", [out4.recovered.length, out4.stillUnresolved], [0, ["Jeremy Pena 1+ hits"]]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
