// Unique Picks (unique-picks.ts): which picks are "the same bet", and how a group's W/L/P is read.
// Pure - no DB. Run with: npx tsx src/lib/unique-picks-acceptance-test.ts
import { summarizeUniquePicks, uniquePickKey, type UniquePickInput } from "@/lib/unique-picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const GAME = new Date("2026-11-07T23:00:00.000Z");
let seq = 0;
function pick(o: Partial<UniquePickInput>): UniquePickInput {
  return {
    id: "p" + ++seq,
    homeTeam: "Boston Celtics",
    awayTeam: "Miami Heat",
    gameTime: GAME,
    betType: "MONEYLINE",
    period: "FULL_GAME",
    betDetail: null,
    pickedSide: "HOME",
    category: null,
    line: null,
    status: "PENDING",
    ...o,
  };
}
const unique = (ps: UniquePickInput[]) => new Set(ps.map(uniquePickKey)).size;

// Grouping
check("10 cappers on the same ML = 1", unique(Array.from({ length: 10 }, () => pick({}))), 1);
const over = (line: number, o: Partial<UniquePickInput> = {}) =>
  pick({ betType: "TOTAL", pickedSide: null, line, betDetail: "Over " + line, category: "NBA_TOTAL_OVER", ...o });
check("Over 71.5 vs Over 72.5 = 2", unique([over(71.5), over(72.5)]), 2);
check("same side, different period = 2", unique([over(71.5), over(71.5, { period: "FIRST_HALF" })]), 2);
check(
  "same player prop, same line = 1",
  unique([
    pick({ betType: "PLAYER_PROP", pickedSide: null, playerName: "Jayson Tatum", propMarket: "POINTS", line: 27.5, betDetail: "Jayson Tatum over 27.5 points" }),
    pick({ betType: "PLAYER_PROP", pickedSide: null, playerName: "jayson  tatum", propMarket: "POINTS", line: 27.5, betDetail: "Tatum O27.5 pts" }),
  ]),
  1
);
check(
  "same player, other stat or other line = 3",
  unique([
    pick({ betType: "PLAYER_PROP", pickedSide: null, playerName: "Jayson Tatum", propMarket: "POINTS", line: 27.5, betDetail: "over 27.5" }),
    pick({ betType: "PLAYER_PROP", pickedSide: null, playerName: "Jayson Tatum", propMarket: "REBOUNDS", line: 27.5, betDetail: "over 27.5" }),
    pick({ betType: "PLAYER_PROP", pickedSide: null, playerName: "Jayson Tatum", propMarket: "POINTS", line: 28.5, betDetail: "over 28.5" }),
  ]),
  3
);
check("one capper on Over + one on Under = 2", unique([over(71.5), over(71.5, { betDetail: "Under 71.5", category: "NBA_TOTAL_UNDER" })]), 2);
check("ML home vs away = 2", unique([pick({}), pick({ pickedSide: "AWAY" })]), 2);
check("spread: same team, different line = 2", unique([pick({ betType: "SPREAD", line: -3 }), pick({ betType: "SPREAD", line: -3.5 })]), 2);
check("doubleheader games are different games", unique([pick({ gameNumber: 1 }), pick({ gameNumber: 2 })]), 2);

// Team totals: team + over/under + line, from the text
const tt = (text: string, line: number | null = 110.5) => pick({ betType: "TEAM_TOTAL", pickedSide: null, line, betDetail: text });
check("team total: same team over same line from 3 cappers = 1", unique([tt("Celtics over 110.5"), tt("Boston Celtics TT Over 110.5"), tt("Celtics team total o110.5 - 2u")]), 1);
check("team total: home over vs away over = 2", unique([tt("Celtics over 110.5"), tt("Heat over 110.5")]), 2);
check("team total: over vs under = 2", unique([tt("Celtics over 110.5"), tt("Celtics under 110.5")]), 2);
check("team total: other line = 2", unique([tt("Celtics over 110.5"), tt("Celtics over 111.5", 111.5)]), 2);

// Status
const noWarn = () => {
  throw new Error("unexpected disagreement");
};
const win = (o = {}) => pick({ status: "WIN", ...o });
const loss = (o = {}) => pick({ status: "LOSS", ...o });
check(
  "each group counts once; pending groups count toward unique only",
  summarizeUniquePicks([win(), win(), win(), loss({ pickedSide: "AWAY" }), pick({ betType: "SPREAD", line: -3 }), pick({ status: "PUSH", betType: "SPREAD", line: -4 })], noWarn),
  { wins: 1, losses: 1, pushes: 1, unique: 4, total: 6 }
);
check(
  "a group is pending only if ALL are pending: a graded copy decides it",
  summarizeUniquePicks([pick({}), pick({}), win()], noWarn),
  { wins: 1, losses: 0, pushes: 0, unique: 1, total: 3 }
);
check("all-cancelled group: unique, in no bucket", summarizeUniquePicks([pick({ status: "CANCELLED" })], noWarn), { wins: 0, losses: 0, pushes: 0, unique: 1, total: 1 });

const seen: unknown[] = [];
const rec = (key: string, ids: string[], counts: unknown) => seen.push({ ids, counts, keyHasGame: key.includes("Boston Celtics") });
const a = win({ id: "a" });
const b = win({ id: "b" });
const c = loss({ id: "c" });
check("disagreement: majority wins and is reported with ids", [summarizeUniquePicks([a, b, c], rec), seen], [
  { wins: 1, losses: 0, pushes: 0, unique: 1, total: 3 },
  [{ ids: ["a", "b", "c"], counts: { WIN: 2, LOSS: 1, PUSH: 0 }, keyHasGame: true }],
]);
check("disagreement tie: counted in no bucket", summarizeUniquePicks([win(), loss()], () => {}), { wins: 0, losses: 0, pushes: 0, unique: 1, total: 2 });
check("empty", summarizeUniquePicks([], noWarn), { wins: 0, losses: 0, pushes: 0, unique: 0, total: 0 });

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
