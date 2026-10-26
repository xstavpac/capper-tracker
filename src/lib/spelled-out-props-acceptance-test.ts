// Proof for spelled-out player-prop lines ("over six receptions", "under two and
// a half shots on goal"). Before, the parsers only read digits after over/under:
// the number word stayed in the player name ("Travis Kelce six"), the roster
// match failed, and parsePlayerPropLine (which every prop grader reads) found no
// line. normalizeSpelledOutPropNumber (number-words.ts) now rewrites it to digits
// at the top of the NFL / NHL / MLB / NBA prop parsers and parsePlayerPropLine.
//   1. the helper itself, and that it is a no-op on everything else;
//   2. the DIGIT TWIN: each spelled-out line, run through the real import path
//      (parseCatalog -> recoverUnresolvedLines, with NFL / NHL / MLB / NBA roster
//      fixtures), recovers exactly the pick its digit twin does;
//   3. the parsers directly: no number word ever lands in a player name;
//   4. the line a grader reads (parsePlayerPropLine), per market;
//   5. the stored text is untouched.
// Pure: no DB, no network. Run with:
//   npx tsx src/lib/spelled-out-props-acceptance-test.ts
import { parseCatalog } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { parsePlayerProp, parsePlayerPropLine } from "@/lib/bet-line";
import { parseNhlPlayerProp } from "@/lib/nhl-prop";
import { parseMlbPlayerProp } from "@/lib/mlb-prop";
import { parseNbaPlayerProp } from "@/lib/nba-prop";
import { normalizeSpelledOutPropNumber, NUMBER_WORDS } from "@/lib/number-words";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

// ---- 1. The helper ----
const n = normalizeSpelledOutPropNumber;
expect("over six", n("Travis Kelce over six receptions"), "Travis Kelce over 6 receptions");
expect("under two", n("Connor McDavid under two shots on goal"), "Connor McDavid under 2 shots on goal");
expect("case of the side word is kept", [n("Kelce OVER SIX receptions"), n("Kelce Under Ten receptions")], ["Kelce OVER 6 receptions", "Kelce Under 10 receptions"]);
expect("and a half", [n("Kelce over six and a half receptions"), n("Judge Under Two And A Half total bases"), n("Jokic over ten and a half rebounds")], ["Kelce over 6.5 receptions", "Judge Under 2.5 total bases", "Jokic over 10.5 rebounds"]);
expect("one through twenty, all of them", Object.keys(NUMBER_WORDS).every((w) => n(`x over ${w} y`) === `x over ${NUMBER_WORDS[w]} y` && n(`x under ${w} and a half y`) === `x under ${NUMBER_WORDS[w] + 0.5} y`), true);
expect("a couple in one line", n("Kelce over six receptions, Allen under two"), "Kelce over 6 receptions, Allen under 2");

// A no-op on everything else (byte-identical).
const UNTOUCHED = [
  "Seven Rivers", // a name
  "Three Rivers over 4.5 receptions", // a name followed by a real line
  "Ten Hag", "Josh Allen over 275.5 passing yards", "Travis Kelce Over 6.5 receptions", "Kelce o6.5 receptions", "Kelce u 6.5 rec",
  "Kelce o six receptions", "Kelce u two receptions", // no shorthand + word
  "Moreover six receptions", "Undersix", "overseven",
  "Jokic over three pointers", "Curry under three-pointers", "Curry over three pt", "Curry over three point", "Curry over Three Points made",
  "Kelce over one hundred receiving yards", "Kelce over twenty-five rec", "Kelce over twenty five rec", "over six point five receptions",
  "Over", "Under 6.5", "six receptions over", "Kelce six receptions", "Kelce over receptions six",
  "Leafs/Oilers over 6.5", "Cubs ML", "Aaron Judge to hit a home run", "Patrick Mahomes anytime TD",
  "",
];
for (const t of UNTOUCHED) expect(`no-op: ${JSON.stringify(t)}`, n(t), t);
// A three that is a plain line (not a market name) is still read.
expect("'over three receptions' / 'over three and a half pointers' are lines", [n("Kelce over three receptions"), n("Curry over three and a half pointers")], ["Kelce over 3 receptions", "Curry over 3.5 pointers"]);
expect("'over three points' stays as typed (three-point market wording)", n("Curry over three points"), "Curry over three points");

// ---- 2. The digit twin through the real import path ----
const player = (playerName: string, team: string, position: string, id: string): RosterPlayer => {
  const [firstName, ...rest] = playerName.split(" ");
  return { playerName, firstName, lastName: rest.join(" "), team, position, externalPlayerId: id };
};
const nfl = [player("Travis Kelce", "Kansas City Chiefs", "TE", "1"), player("Josh Allen", "Buffalo Bills", "QB", "2")];
const nhl = [player("Connor McDavid", "Edmonton Oilers", "C", "9")];
const mlb = [player("Aaron Judge", "New York Yankees", "RF", "8"), player("Gerrit Cole", "New York Yankees", "P", "10")];
const nba = [player("Nikola Jokic", "Denver Nuggets", "C", "7")];
const everyName = [...nfl, ...nhl, ...mlb, ...nba].map((p) => p.playerName);

const run = (line: string) => {
  const cat = parseCatalog("Cap\n\n" + line, [], everyName);
  const rec = recoverUnresolvedLines(cat.unresolved, [], [], nfl, [], nhl, mlb, [], nba);
  const p = (rec.recovered[0] ?? cat.picks[0]) as unknown as Record<string, unknown> | undefined;
  return { direct: cat.picks.length, recovered: rec.recovered.length, stillUnresolved: rec.stillUnresolved.length, pick: p };
};
// What identifies the recovered pick, apart from the text the capper typed.
const identity = (p: Record<string, unknown> | undefined) => {
  if (!p) return null;
  const { description: _d, raw: _r, ...rest } = p;
  return rest;
};
const TWINS: [string, string, string][] = [
  ["NFL receptions", "Travis Kelce over six receptions", "Travis Kelce over 6 receptions"],
  ["NFL receptions, under, with a half", "Travis Kelce under six and a half receptions", "Travis Kelce under 6.5 receptions"],
  ["NFL receiving yards", "Travis Kelce over twenty receiving yards", "Travis Kelce over 20 receiving yards"],
  ["NFL passing touchdowns", "Josh Allen over two passing touchdowns", "Josh Allen over 2 passing touchdowns"],
  ["NHL shots on goal", "Connor McDavid over two shots on goal", "Connor McDavid over 2 shots on goal"],
  ["NHL shots on goal, with a half", "Connor McDavid over two and a half shots on goal", "Connor McDavid over 2.5 shots on goal"],
  ["MLB total bases", "Aaron Judge over two total bases", "Aaron Judge over 2 total bases"],
  ["MLB strikeouts, with a half", "Gerrit Cole under five and a half strikeouts", "Gerrit Cole under 5.5 strikeouts"],
  ["NBA rebounds", "Nikola Jokic over ten rebounds", "Nikola Jokic over 10 rebounds"],
  ["NBA assists, with a half", "Nikola Jokic over eight and a half assists", "Nikola Jokic over 8.5 assists"],
];
for (const [label, spelled, digits] of TWINS) {
  const a = run(spelled);
  const d = run(digits);
  expect(`twin (${label}): the digit line is recovered as a pick`, [d.recovered + d.direct >= 1, d.stillUnresolved], [true, 0]);
  expect(`twin (${label}): the spelled-out line is recovered the same way`, [a.direct, a.recovered, a.stillUnresolved], [d.direct, d.recovered, d.stillUnresolved]);
  expect(`twin (${label}): same pick, field for field`, identity(a.pick), identity(d.pick));
  expect(`twin (${label}): the stored text is what the capper typed`, (a.pick as { description?: string } | undefined)?.description, spelled);
}

// ---- 3. The parsers: never a number word in a name ----
const NUMBER_WORD_IN_NAME = new RegExp(`\\b(?:${Object.keys(NUMBER_WORDS).join("|")})\\b`, "i");
const parsers: [string, (t: string) => { playerName: string; propMarket: string } | null, string, string][] = [
  ["NFL", parsePlayerProp, "Travis Kelce over six receptions", "Travis Kelce over 6 receptions"],
  ["NHL", parseNhlPlayerProp, "Connor McDavid over two shots on goal", "Connor McDavid over 2 shots on goal"],
  ["MLB", parseMlbPlayerProp, "Aaron Judge over two total bases", "Aaron Judge over 2 total bases"],
  ["NBA", parseNbaPlayerProp, "Nikola Jokic over ten rebounds", "Nikola Jokic over 10 rebounds"],
];
for (const [sport, parse, spelled, digits] of parsers) {
  const a = parse(spelled);
  expect(`${sport}: the spelled-out line parses to the digit twin's result`, a, parse(digits));
  expect(`${sport}: and it is a real parse with a clean name`, [a !== null, a !== null && !NUMBER_WORD_IN_NAME.test(a.playerName)], [true, true]);
}

// ---- 4. The line a grader reads ----
for (const [spelled, digits, want] of [
  ["Travis Kelce over six receptions", "Travis Kelce over 6 receptions", { direction: "OVER", line: 6 }],
  ["Travis Kelce under six and a half receptions", "Travis Kelce under 6.5 receptions", { direction: "UNDER", line: 6.5 }],
  ["Connor McDavid OVER TWO shots on goal", "Connor McDavid OVER 2 shots on goal", { direction: "OVER", line: 2 }],
  ["Gerrit Cole under five and a half strikeouts", "Gerrit Cole under 5.5 strikeouts", { direction: "UNDER", line: 5.5 }],
  ["Nikola Jokic over ten rebounds", "Nikola Jokic over 10 rebounds", { direction: "OVER", line: 10 }],
  ["Kelce over twenty receiving yards", "Kelce over 20 receiving yards", { direction: "OVER", line: 20 }],
] as const) {
  expect(`parsePlayerPropLine: ${JSON.stringify(spelled)}`, [parsePlayerPropLine(spelled), parsePlayerPropLine(digits)], [want, want]);
}
expect("parsePlayerPropLine: lines it read before are unchanged", [parsePlayerPropLine("Josh Allen Over 275.5 Passing Yards"), parsePlayerPropLine("Mike Evans o56.5"), parsePlayerPropLine("Kelce six receptions")], [{ direction: "OVER", line: 275.5 }, { direction: "OVER", line: 56.5 }, null]);

// ---- 5. Stored text ----
expect("the normalizer is applied when a parser reads, never to the stored text (a parser takes text in, returns no text)", parsePlayerProp("Travis Kelce over six receptions")?.playerName, "Travis Kelce");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
