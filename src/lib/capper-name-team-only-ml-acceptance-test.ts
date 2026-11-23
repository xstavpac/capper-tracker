// Proof for two catalog-import rules. Run with:
//   npx tsx src/lib/capper-name-team-only-ml-acceptance-test.ts
//
// 1. A saved capper's own name written into the pick ("Picks Office Orlando
//    Magic") is taken out before the team is resolved; it no longer reads the
//    whole line as a header / a capper called "Picks Office Orlando Magic".
// 2. What is left, one team and no other market, is a MONEYLINE for that team.
//    Spread, total, player/prop and ambiguous-city lines keep their handling.
//
// Pure: no network, no database.
import { parseCatalog } from "@/lib/parse-catalog";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

function one(text: string, saved: string[]) {
  const out = parseCatalog(text, saved);
  return {
    picks: out.picks.map((p) => ({ c: p.capperName, s: p.sportName, d: p.description, b: p.betType, amb: p.ambiguousKey ?? null })),
    unresolved: out.unresolved.length,
  };
}
const PO = ["Picks Office"];
const ml = (s: string, d: string, c = "Picks Office") => ({ picks: [{ c, s, d, b: "MONEYLINE", amb: null }], unresolved: 0 });

// Prefix removal, with and without punctuation / case differences.
expect("plain prefix NBA", one("Picks Office\nPicks Office Orlando Magic", PO), ml("NBA", "Orlando Magic"));
expect("lower case prefix", one("Picks Office\npicks office orlando magic", PO), ml("NBA", "orlando magic"));
expect("colon", one("Picks Office\nPicks Office: Orlando Magic", PO), ml("NBA", "Orlando Magic"));
expect("dash", one("Picks Office\nPicks Office - Orlando Magic", PO), ml("NBA", "Orlando Magic"));
expect("extra spaces", one("Picks Office\nPicks   Office   Orlando Magic", PO), ml("NBA", "Orlando Magic"));
expect("trailing capper name", one("Picks Office\nOrlando Magic - Picks Office", PO), ml("NBA", "Orlando Magic"));
expect("works with no active header", one("Picks Office Orlando Magic", PO), ml("NBA", "Orlando Magic"));

// Team-only -> ML across leagues.
expect("NFL", one("Picks Office\nPicks Office Kansas City Chiefs", PO), ml("NFL", "Kansas City Chiefs"));
expect("MLB", one("Picks Office\nPicks Office Boston Red Sox", PO), ml("MLB", "Boston Red Sox"));

// Other market signals keep their handling.
expect("team + spread stays spread", one("Picks Office\nPicks Office Orlando Magic -3", PO).picks[0].b, "SPREAD");
expect("team + total stays total", one("Picks Office\nPicks Office Orlando Magic over 215.5", PO).picks[0].b, "TOTAL");
expect("explicit ML unchanged", one("Picks Office\nPicks Office Orlando Magic ML", PO).picks[0].b, "MONEYLINE");

// Ambiguity is untouched: a shared city is still a question, not a guess.
const amb = one("Picks Office\nPicks Office Arizona", PO);
expect("ambiguous city stays ambiguous", [amb.picks.length, amb.picks[0]?.amb], [1, "arizona"]);
expect("ambiguous city with spread", one("Picks Office\nPicks Office Orlando -3.5", PO).picks[0].amb, "orlando");

// No capper prefix: a bare team line is still a header (capper-header rule).
expect("bare team line is still a header", one("Picks Office\nOrlando Magic", PO).picks.length, 0);
// A different, unsaved capper's name is not stripped.
expect("unsaved name not stripped", one("Sharp Sam\nOrlando Magic", PO).picks.length, 0);

// A capper whose name is itself team-like keeps the existing handling.
const TEAMY = ["Magic"];
expect("team-like capper name: bare line is a header", one("Magic\nMagic", TEAMY).picks.length, 0);
expect("team-like capper name: exact name is not a pick", one("Magic\nOrlando Magic", TEAMY).picks.length, 0);

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll passed");
