// Proof for the automated paths' capper-name guard (lib/capper-name-guard.ts). Run with:
//   npx tsx src/lib/capper-name-guard-acceptance-test.ts
//
// 1. Junk names are refused as cappers (numbers, bet syntax, teams, roster players, promo, pick fragments) and real
//    capper names are not.
// 2. Obvious variants are filed under the ONE saved capper they belong to; unrelated or ambiguous names are not.
// 3. Parsing with acceptNewHeader: a junk header is skipped and its picks stay with the capper above it; a promo line
//    is dropped before parsing and the real picks in the same message still parse. Without the option nothing changes.
// 4. Recipient copies: junk is not copied, variants are filed under the recipient's saved capper.
//
// Pure: no network, no database.
import { capperNameJunkReason, findCapperVariant, isPromoLine, recipientCapperName } from "@/lib/capper-name-guard";
import { normalizeName } from "@/lib/fuzzy-match";
import { parseCatalog } from "@/lib/parse-catalog";
import { preFilterIngestText } from "@/lib/ingest-filters";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const playerKeys = new Set(["Leon Draisaitl", "Jayson Tatum"].map(normalizeName));
const junk = (name: string) => capperNameJunkReason(name, { playerKeys });

// ---- 1. junk ----
expect("3.5", junk("3.5"), "number");
expect("+150", junk("+150"), "number");
expect("keycap emoji only", junk("2️⃣"), "number");
expect("LOCKS", junk("LOCKS"), "fragment");
expect("**LOCK**", junk("**LOCK**"), "fragment");
expect("POTD", junk("POTD"), "fragment");
expect("Celtics", junk("Celtics"), "team");
expect("Red Wings", junk("Red Wings"), "team");
expect("Tampa Bay Rays", junk("Tampa Bay Rays"), "team");
expect("Cleveland Cavaliers", junk("Cleveland Cavaliers"), "team");
expect("Pistons + Celtics + Raptors MLP", junk("Pistons + Celtics + Raptors MLP"), "bet_syntax");
expect("Leon Draisaitl Goal", junk("Leon Draisaitl Goal"), "bet_syntax");
expect("Leon Draisaitl (roster player)", junk("Leon Draisaitl"), "player");
expect("Lakers ML", junk("Lakers ML"), "bet_syntax");
expect("Celtics -5.5", junk("Celtics -5.5"), "bet_syntax");
expect("o8.5", junk("o8.5"), "bet_syntax");
expect("STILL HAVE TIME TO GET ON BOARD", junk("STILL HAVE TIME TO GET ON BOARD"), "promo");
expect("2️⃣**DAYS FOR THE PRICE OF****1", junk("2️⃣**DAYS FOR THE PRICE OF****1"), "promo");
for (const real of [
  "MCBETS",
  "DirtyBubbleBets",
  "ANDERSPICKS",
  "Pardon My Pick",
  "SENSEI Sam",
  "SenseiSam VIP",
  "HAMMERING HANK",
  "Hammering",
  "Five",
  "Cash it baby",
  "Empire",
  "Over Achievers",
  "Picks Office",
  "Bambino",
]) {
  expect(`real capper "${real}" is not junk`, junk(real), null);
}

// ---- 2. variants ----
const saved = [
  "DirtyBubbleBets",
  "MCBETS",
  "ANDERSPICKS",
  "Pardon My Pick",
  "SENSEI Sam",
  "HAMMERING HANK",
  "Five",
  "Cash it baby",
  "Empire",
  "Picks Office",
  "Bambino",
];
const variants: [string, string][] = [
  ["DIRTY BUBBLE", "DirtyBubbleBets"],
  ["MCBETSCS", "MCBETS"],
  ["Anders", "ANDERSPICKS"],
  ["Pardon My PICK Sam", "Pardon My Pick"],
  ["SenseiSam VIP", "SENSEI Sam"],
  ["Hammering", "HAMMERING HANK"],
  ["Five (Live bet", "Five"],
  ["Cash It, Baby Carlos", "Cash it baby"],
  ["Empire Sam", "Empire"],
];
for (const [raw, target] of variants) expect(`variant "${raw}" -> ${target}`, findCapperVariant(raw, saved), target);
expect("exact (case) match needs no rewrite", findCapperVariant("mcbets", saved), null);
expect("unrelated name: no variant", findCapperVariant("Sharp Shooter", saved), null);
expect("different person sharing a first word: no variant", findCapperVariant("Michael Smith", ["Michael Jones"]), null);
expect("two saved candidates: ambiguous, no variant", findCapperVariant("Empire", ["Empire Sam", "Empire Picks Joe"]), null);
expect("long glued tail is not a variant", findCapperVariant("MCBETSCLUB", saved), null);
// Found by the prod cleanup dry run (2026-11-24): a trailing brand word makes a different capper.
expect("Sharp investments is not SHARP", findCapperVariant("Sharp investments", ["SHARP"]), null);
expect("SHARP SHEET is not SHARP", findCapperVariant("SHARP SHEET", ["SHARP"]), null);
expect("PARLAY SAFARI is a real capper, not bet syntax", junk("PARLAY SAFARI"), null);
expect("iamparlayp is a real capper", junk("iamparlayp"), null);
expect("recipient: PARLAY SAFARI is still copied", recipientCapperName("PARLAY SAFARI", []), "PARLAY SAFARI");
expect(
  "stored DIFFERENT answer wins",
  findCapperVariant("Empire Sam", saved, [{ rawKey: "empiresam", suggestedKey: "empire", decision: "DIFFERENT" }]),
  null
);

// ---- 3. parsing ----
const accept = (name: string) => capperNameJunkReason(name) === null;
const picksOf = (out: ReturnType<typeof parseCatalog>) => out.picks.map((p) => [p.capperName, p.description]);

const withFragment = "MCBETS\nLOCKS\nLakers -4.5\nCeltics ML";
expect(
  "guarded: LOCKS sub-header is skipped, picks stay with MCBETS",
  picksOf(parseCatalog(withFragment, ["MCBETS"], undefined, undefined, { acceptNewHeader: accept })).map((p) => p[0]),
  ["MCBETS", "MCBETS"]
);
expect(
  "unguarded (the form): unchanged, LOCKS is a header",
  picksOf(parseCatalog(withFragment, ["MCBETS"])).map((p) => p[0]),
  ["LOCKS", "LOCKS"]
);
expect(
  "guarded: refused header is reported",
  parseCatalog(withFragment, ["MCBETS"], undefined, undefined, { acceptNewHeader: accept }).rejectedHeaders,
  [{ text: "LOCKS", capperName: "MCBETS" }]
);
expect(
  "guarded: a junk header with no capper above leaves its picks with no capper (never a placeholder)",
  parseCatalog("3.5\nLakers -4.5", [], undefined, undefined, { acceptNewHeader: accept }).picks.map((p) => p.capperName),
  [""]
);
expect(
  "guarded: a real new capper header still becomes the capper",
  parseCatalog("Sharp Shooter\nLakers -4.5", [], undefined, undefined, { acceptNewHeader: accept }).picks.map((p) => p.capperName),
  ["Sharp Shooter"]
);

expect("promo line", isPromoLine("2️⃣**DAYS FOR THE PRICE OF****1"), true);
expect("promo line 2", isPromoLine("🚨 STILL HAVE TIME TO GET ON BOARD 🚨"), true);
expect("a pick is not promo", isPromoLine("Lakers -4.5"), false);
const promoMessage = "MCBETS\n2️⃣**DAYS FOR THE PRICE OF****1\nLakers -4.5\nSTILL HAVE TIME TO GET ON BOARD\nCeltics ML";
const pre = preFilterIngestText(promoMessage);
expect("promo lines are dropped and logged", pre.skipped.map((s) => s.rawText), ["2️⃣**DAYS FOR THE PRICE OF****1", "STILL HAVE TIME TO GET ON BOARD"]);
expect(
  "real picks in a message with promo lines still parse, under the real capper",
  picksOf(parseCatalog(pre.text, ["MCBETS"], undefined, undefined, { acceptNewHeader: accept })),
  [
    ["MCBETS", "Lakers -4.5"],
    ["MCBETS", "Celtics ML"],
  ]
);

// ---- 4. recipient copies ----
expect("recipient: variant filed under the recipient's capper", recipientCapperName("DIRTY BUBBLE", ["DirtyBubbleBets"]), "DirtyBubbleBets");
expect("recipient: unknown real name kept", recipientCapperName("Sharp Shooter", ["DirtyBubbleBets"]), "Sharp Shooter");
expect("recipient: junk not copied", recipientCapperName("3.5", ["DirtyBubbleBets"]), null);
expect("recipient: team not copied", recipientCapperName("Red Wings", []), null);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
