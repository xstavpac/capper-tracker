// Proof for capper section headers ("CBB", "College Basketball", "CFB" above a group of picks) and the
// CBB / CFB inline codes - run with:
//   npx tsx src/lib/catalog-section-header-acceptance-test.ts
//
// No test framework in this repo. console.logs PASS/FAIL, exits non-zero on any failure. No DB, no network.

import { NCAAB_LISTED_TEAMS } from "@/lib/college-teams";
import { parseCatalog, sectionHeaderSport, withCollegeCandidates, type ParsedPick } from "@/lib/parse-catalog";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// As production builds it (catalog-import-orchestrator): feed teams include the NCAAB list, and the
// shared-school step runs over the parse.
const SAVED = ["Sharp", "Kleos"];
const parse = (text: string) => parseCatalog(text, SAVED, undefined, [...NCAAB_LISTED_TEAMS]);
const picksOf = (text: string) => withCollegeCandidates(parse(text).picks);
// capper | sport (or PROMPT a/b) | description
const show = (p: ParsedPick) => `${p.capperName}|${p.ambiguous ? "PROMPT " + p.ambiguous.map((o) => o.sport).join("/") : p.sportName}|${p.description}`;
const outcomes = (text: string) => picksOf(text).map(show);

// ---- The matcher on its own.
for (const [line, sport] of [
  ["CBB", "NCAAB"],
  ["cbb picks", "NCAAB"],
  ["NCAAB", "NCAAB"],
  ["NCAAB Picks", "NCAAB"],
  ["NCAA Basketball", "NCAAB"],
  ["College Basketball", "NCAAB"],
  ["College Hoops", "NCAAB"],
  ["Men's College Basketball", "NCAAB"],
  ["🏀 CBB Plays 🏀", "NCAAB"],
  ["**CBB**", "NCAAB"],
  ["- CBB:", "NCAAB"],
  ["CFB", "NCAAF"],
  ["NCAAF bets", "NCAAF"],
  ["College Football Card", "NCAAF"],
  ["🏈 College Football 🏈", "NCAAF"],
] as const) {
  check(`header "${line}" -> ${sport}`, sectionHeaderSport(line), sport);
}
for (const line of ["CBB Kings", "Five Star CBB", "Duke -4.5", "NBA", "College", "CBB Duke -4.5", "Basketball", "3️⃣ CBB"]) {
  check(`not a section header: "${line}"`, sectionHeaderSport(line), null);
}

// ---- 1. "CBB" no longer becomes a capper; shared schools under it are NCAAB with no question.
for (const header of ["CBB", "College Basketball", "College Hoops", "NCAAB", "NCAAB picks", "🏀 CBB 🏀"]) {
  check(`"${header}" header: picks stay with Sharp, NCAAB, no question`, outcomes(`Sharp\n${header}\nDuke -4.5\nAlabama ML`), [
    "Sharp|NCAAB|Duke -4.5",
    "Sharp|NCAAB|Alabama ML",
  ]);
}
{
  const ps = picksOf("Sharp\nCBB\nDuke -4.5\nAlabama ML");
  check("header picks are marked sportExplicit", ps.map((p) => p.sportExplicit), [true, true]);
  check("header picks carry their school", ps.map((p) => p.teamNicknames.length > 0), [true, true]);
  check("no capper named CBB", parse("Sharp\nCBB\nDuke -4.5").picks.some((p) => p.capperName === "CBB"), false);
}
// Without the header the same lines are still the NCAAF / NCAAB question (unchanged behaviour).
check("no header: shared schools are still a question", outcomes("Sharp\nDuke -4.5\nAlabama ML"), [
  "Sharp|PROMPT NCAAF/NCAAB|Duke -4.5",
  "Sharp|PROMPT NCAAF/NCAAB|Alabama ML",
]);
// A header that opens the message, with the capper on the next line, belongs to no capper: the capper header resets it.
check("header before the capper is reset by the capper header", outcomes("CBB\nSharp\nDuke -4.5"), ["Sharp|PROMPT NCAAF/NCAAB|Duke -4.5"]);

// ---- 2. Scope.
check("a blank line does not end the section", outcomes("Sharp\nCBB\n\nDuke -4.5\n\nAlabama ML"), [
  "Sharp|NCAAB|Duke -4.5",
  "Sharp|NCAAB|Alabama ML",
]);
check("a new capper header resets the section", outcomes("Sharp\nCBB\nDuke -4.5\n\nFive Star\nDuke -4.5"), [
  "Sharp|NCAAB|Duke -4.5",
  "Five Star|PROMPT NCAAF/NCAAB|Duke -4.5",
]);
check("a saved capper's header resets the section", outcomes("Sharp\nCBB\nDuke -4.5\nKleos\nDuke -4.5"), [
  "Sharp|NCAAB|Duke -4.5",
  "Kleos|PROMPT NCAAF/NCAAB|Duke -4.5",
]);
check("a repeated header for the same capper resets the section", outcomes("Sharp\nCBB\nDuke -4.5\nSharp\nDuke -4.5"), [
  "Sharp|NCAAB|Duke -4.5",
  "Sharp|PROMPT NCAAF/NCAAB|Duke -4.5",
]);
check("a different bare code (NBA) ends the section", outcomes("Sharp\nCBB\nDuke -4.5\nNBA\nLakers -3\nDuke -4.5"), [
  "Sharp|NCAAB|Duke -4.5",
  "Sharp|NBA|Lakers -3",
  "Sharp|PROMPT NCAAF/NCAAB|Duke -4.5",
]);
check("one message, a CBB and a CFB section", outcomes("Sharp\nCBB\nDuke -4.5\nAlabama ML\nCFB\nAlabama -7\nDuke +3"), [
  "Sharp|NCAAB|Duke -4.5",
  "Sharp|NCAAB|Alabama ML",
  "Sharp|NCAAF|Alabama -7",
  "Sharp|NCAAF|Duke +3",
]);
check("two cappers, each with their own section", outcomes("Sharp\nCBB\nDuke -4.5\n\nFive Star\nCFB\nDuke +3"), [
  "Sharp|NCAAB|Duke -4.5",
  "Five Star|NCAAF|Duke +3",
]);
check("a pro-team nickname under a CBB header is left alone", outcomes("Sharp\nCBB\nLakers -3\nDuke -4.5"), [
  "Sharp|NBA|Lakers -3",
  "Sharp|NCAAB|Duke -4.5",
]);
check("a saved capper's inline pick under its own header takes the section", outcomes("Sharp\nCBB\nSharp Duke -4.5"), [
  "Sharp|NCAAB|Duke -4.5",
]);

// ---- 3. The pick's own code beats the header.
check("NCAAF on the line beats a CBB header", outcomes("Sharp\nCBB\nNCAAF Alabama -7\nDuke -4.5"), [
  "Sharp|NCAAF|Alabama -7",
  "Sharp|NCAAB|Duke -4.5",
]);
check("trailing CFB on the line beats a CBB header", outcomes("Sharp\nCBB\nAlabama -7 CFB"), ["Sharp|NCAAF|Alabama -7"]);
check("NCAAB on the line beats a CFB header", outcomes("Sharp\nCFB\nNCAAB Duke -4.5"), ["Sharp|NCAAB|Duke -4.5"]);
{
  const ps = picksOf("Sharp\nCBB\nNCAAF Alabama -7");
  check("a pick settled by its own code is not marked sportExplicit", ps[0].sportExplicit, undefined);
}

// ---- 4. Inline CBB / CFB and the trailing code.
check("CBB prefix", outcomes("Sharp\nCBB Duke -4.5"), ["Sharp|NCAAB|Duke -4.5"]);
check("CFB prefix", outcomes("Sharp\nCFB Duke -4.5"), ["Sharp|NCAAF|Duke -4.5"]);
check("trailing CBB", outcomes("Sharp\nDuke -4.5 CBB"), ["Sharp|NCAAB|Duke -4.5"]);
check('"Duke -4.5 NCAAB" is kept (was silently dropped)', outcomes("Sharp\nDuke -4.5 NCAAB\nAlabama ML NCAAF"), [
  "Sharp|NCAAB|Duke -4.5",
  "Sharp|NCAAF|Alabama ML",
]);
check("trailing code on a saved capper's inline pick", outcomes("Sharp Duke -4.5 NCAAB"), ["Sharp|NCAAB|Duke -4.5"]);
check('"BAMBINO - NCAAB" names the capper and opens an NCAAB section', outcomes("BAMBINO - NCAAB\nDuke -4.5"), ["BAMBINO|NCAAB|Duke -4.5"]);

// ---- 5. NBA / NHL / NFL blocks are unchanged.
{
  const text = "Sharp\nNBA\nLakers -3\nNHL\nBruins ML\nNFL\nChiefs -3\n\nKleos\nCeltics -5.5\nRangers ML\nEagles +3";
  const ps = picksOf(text);
  check("pro blocks: sports and cappers", ps.map(show), [
    "Sharp|NBA|Lakers -3",
    "Sharp|NHL|Bruins ML",
    "Sharp|NFL|Chiefs -3",
    "Kleos|NBA|Celtics -5.5",
    "Kleos|PROMPT MLB/NHL|Rangers ML",
    "Kleos|PROMPT NFL/KBO|Eagles +3",
  ]);
  check("pro blocks: nothing marked sportExplicit", ps.some((p) => "sportExplicit" in p), false);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
