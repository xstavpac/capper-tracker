// Proof for the conservative live-schedule fallback (Variant 1) - run with:
//   npx tsx src/lib/live-team-fallback-acceptance-test.ts
//
// This is the last-resort resolver for catalog lines parse-catalog.ts left
// unresolved. The whole point is that it NEVER guesses: exactly one live
// team must match, or the line stays unresolved. These tests lean hard on
// the non-resolving cases.
import {
  resolveLineAgainstLiveTeams,
  buildTeamKeys,
  parseFallbackBetText,
  type LiveTeam,
} from "./live-team-fallback";
import { parseCatalog } from "./parse-catalog";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// A realistic "big Saturday" NCAAF board plus a couple of pro games, as the
// feeds would return them (ESPN displayName spelling). VMI and Furman are
// FCS schools playing FBS "money games" - the exact case the static list
// misses.
const BOARD: LiveTeam[] = [
  { sport: "NCAAF", name: "Army Black Knights" },
  { sport: "NCAAF", name: "VMI Keydets" },
  { sport: "NCAAF", name: "Clemson Tigers" },
  { sport: "NCAAF", name: "Florida State Seminoles" },
  { sport: "NCAAF", name: "Florida Gators" },
  { sport: "NCAAF", name: "Florida Atlantic Owls" },
  { sport: "NCAAF", name: "Florida International Panthers" },
  { sport: "NCAAF", name: "South Florida Bulls" },
  { sport: "NCAAF", name: "Eastern Michigan Eagles" },
  { sport: "NCAAF", name: "Central Michigan Chippewas" },
  { sport: "NCAAF", name: "New Mexico Lobos" },
  { sport: "NCAAF", name: "New Mexico State Aggies" },
  { sport: "NCAAF", name: "Furman Paladins" },
  { sport: "NCAAF", name: "Wofford Terriers" },
  { sport: "NFL", name: "Carolina Panthers" },
  { sport: "NFL", name: "Miami Dolphins" },
  { sport: "NHL", name: "Florida Panthers" },
];

console.log("########## VMI-style FCS-vs-FBS: resolves ##########");
{
  const r = resolveLineAgainstLiveTeams("VMI +21.5", BOARD);
  check("'VMI +21.5' -> NCAAF, VMI Keydets (short all-caps school abbrev)", r, {
    status: "resolved",
    sport: "NCAAF",
    nickname: "vmi keydets",
    matchedName: "VMI Keydets",
    via: "acronym",
  });
}
{
  const r = resolveLineAgainstLiveTeams("Furman ML", BOARD);
  check("'Furman ML' -> NCAAF, Furman Paladins (long single-word prefix)", { s: r.status, sport: (r as any).sport, name: (r as any).matchedName }, {
    s: "resolved",
    sport: "NCAAF",
    name: "Furman Paladins",
  });
}
{
  // spelled-out multi-word name the static list happens to have, but proves
  // the phrase-key path
  const r = resolveLineAgainstLiveTeams("Florida International +14.5", BOARD);
  check("'Florida International +14.5' -> FIU via the unique 2-word prefix", { s: r.status, name: (r as any).matchedName, via: (r as any).via }, {
    s: "resolved",
    name: "Florida International Panthers",
    via: "prefix",
  });
}
{
  const r = resolveLineAgainstLiveTeams("FIU +14.5", BOARD);
  check("'FIU +14.5' -> FIU via the derived acronym (all-caps token)", { s: r.status, name: (r as any).matchedName, via: (r as any).via }, {
    s: "resolved",
    name: "Florida International Panthers",
    via: "acronym",
  });
}
{
  const r = resolveLineAgainstLiveTeams("EMU -3", BOARD);
  check("'EMU -3' -> Eastern Michigan via acronym", (r as any).matchedName, "Eastern Michigan Eagles");
}

console.log("\n########## conservative: never guesses ##########");
{
  // "florida" is a prefix of FOUR live teams -> not a usable key for any of
  // them. A bare "Florida +7" cannot be pinned, so it stays unresolved.
  const r = resolveLineAgainstLiveTeams("Florida +7", BOARD);
  check("'Florida +7' with 4 Florida teams live -> unresolved (shared prefix)", r.status, "unresolved");
}
{
  // "new mexico" is shared by Lobos and State -> neither claims it. Not a
  // false pick for one of them.
  const r = resolveLineAgainstLiveTeams("New Mexico +3", BOARD);
  check("'New Mexico +3' with Lobos AND State live -> unresolved", r.status, "unresolved");
}
{
  // A bare mascot is never a key - "panthers" is the mascot of an NCAAF, an
  // NFL, and an NHL team on this board and a prefix of none of them.
  const r = resolveLineAgainstLiveTeams("Panthers +7", BOARD);
  check("bare 'Panthers +7' -> unresolved (mascot, not a name prefix)", r.status, "unresolved");
}
{
  const r = resolveLineAgainstLiveTeams("Tigers ML", BOARD);
  check("bare 'Tigers ML' -> unresolved", r.status, "unresolved");
}
{
  // lowercase "fiu" is how a person's name reads, not an abbreviation -
  // acronym keys only match an ALL-CAPS standalone token.
  const r = resolveLineAgainstLiveTeams("fiu +14.5", BOARD);
  check("lowercase 'fiu +14.5' -> unresolved (acronyms need all-caps)", r.status, "unresolved");
}
{
  // A genuine acronym collision -> ambiguous, which the caller treats as
  // unresolved.
  const collide: LiveTeam[] = [
    { sport: "NCAAF", name: "Florida International Panthers" }, // -> fiu
    { sport: "NCAAB", name: "Florida Institute Sharks" }, // "florida institute" -> fiu too
  ];
  const r = resolveLineAgainstLiveTeams("FIU +5", collide);
  check("'FIU +5' matching two different schools -> ambiguous (not a guess)", r.status, "ambiguous");
  check("ambiguous result names both", (r as any).matches?.map((m: any) => m.name).sort(), [
    "Florida Institute Sharks",
    "Florida International Panthers",
  ]);
}

console.log("\n########## all-FCS matchup: neither feed carries it -> unresolved ##########");
{
  // Merrimack @ Stonehill is an all-FCS/D-II game - it appears in NEITHER
  // the ESPN FBS scoreboard nor the Odds API NCAAF list, so no live team is
  // named "Merrimack..." for the fallback to match.
  const r = resolveLineAgainstLiveTeams("Merrimack +28.5", BOARD);
  check("'Merrimack +28.5' (not on any feed) -> unresolved", r.status, "unresolved");
  const r2 = resolveLineAgainstLiveTeams("Stonehill vs Merrimack under 42", BOARD);
  check("all-FCS matchup line -> unresolved", r2.status, "unresolved");
}
{
  const r = resolveLineAgainstLiveTeams("Some Random Team +3", []);
  check("empty board -> unresolved", r.status, "unresolved");
}

console.log("\n########## buildTeamKeys ##########");
{
  const keys = buildTeamKeys([
    { sport: "NCAAF", name: "Florida International Panthers" },
    { sport: "NCAAF", name: "Florida State Seminoles" },
    { sport: "NCAAF", name: "Florida Gators" },
    { sport: "NCAAF", name: "VMI Keydets" },
  ]);
  const fiu = keys.find((k) => k.team.name === "Florida International Panthers")!;
  check("FIU phrase keys: full name + the unique 2-word prefix, NOT bare 'florida'", fiu.phraseKeys.sort(), [
    "florida international",
    "florida international panthers",
  ]);
  check("FIU acronym keys include 'fiu'", fiu.acronymKeys.has("fiu"), true);

  const vmi = keys.find((k) => k.team.name === "VMI Keydets")!;
  check("VMI: full name is a phrase key", vmi.phraseKeys.includes("vmi keydets"), true);
  // "vmi" is 3 chars, so it's an ALL-CAPS-only acronym key, never a bare
  // spelled-out phrase key.
  check("'vmi' is an acronym key, not a phrase key", [vmi.acronymKeys.has("vmi"), vmi.phraseKeys.includes("vmi")], [true, false]);

  const gators = keys.find((k) => k.team.name === "Florida Gators")!;
  check("Florida Gators: 'florida' is NOT a key (shared)", gators.phraseKeys.includes("florida"), false);
}

console.log("\n########## parseFallbackBetText ##########");
check("'VMI +21.5' -> SPREAD, -110 default, 1u", parseFallbackBetText("VMI +21.5"), {
  betType: "SPREAD",
  odds: -110,
  hasExplicitOdds: false,
  units: 1,
});
check("'Furman ML +180' -> MONEYLINE with explicit odds", parseFallbackBetText("Furman ML +180"), {
  betType: "MONEYLINE",
  odds: 180,
  hasExplicitOdds: true,
  units: 1,
});
check("'Wofford over 44.5 (2u)' -> TOTAL over, 2 units", parseFallbackBetText("Wofford over 44.5 (2u)"), {
  betType: "TOTAL",
  odds: -110,
  hasExplicitOdds: false,
  totalSide: "over",
  units: 2,
});
check("'-14' spread number is not read as odds", parseFallbackBetText("VMI -14").hasExplicitOdds, false);

console.log("\n########## parse-catalog.ts is untouched: still pure + synchronous ##########");
{
  const result = parseCatalog("Capper\nClemson +6.5", []);
  check("parseCatalog returns a plain object synchronously (not a Promise)", result instanceof Promise, false);
  check("parseCatalog output shape unchanged", { picks: result.picks.length, unresolved: result.unresolved.length }, { picks: 1, unresolved: 0 });
  check("a real FCS-only line is still unresolved from parseCatalog alone (the fallback is separate)", parseCatalog("Cap\nVMI +21.5", []).unresolved, ["VMI +21.5"]);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
