// Proof for changed-legs.ts (which legs a Regenerate changed, for the result card's highlight). Pure: no DB.
// Run with:
//   npx tsx src/lib/parlay/changed-legs-acceptance-test.ts
import { changedLegPickIds } from "@/lib/parlay/changed-legs";
import type { EngineLeg } from "@/lib/parlay/generator";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const FUTURE = "2099-06-01T23:00:00.000Z";
function leg(pickId: string, g: number, detail: string, betType = "MONEYLINE", line: number | null = null): EngineLeg {
  const pick = {
    pickId, gameId: "G" + g, betType, period: "FULL_GAME", rawBetDetail: detail, betDetail: detail, line,
    homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", gameTime: FUTURE, leagueName: "MLB",
  };
  return { pick, gameId: pick.gameId } as unknown as EngineLeg;
}
const ids = (s: Set<string>) => [...s].sort();

const a = leg("a", 0, "Yankees ML");
const b = leg("b", 1, "Over 8.5", "TOTAL", 8.5);
const c = leg("c", 2, "Under 8.5", "TOTAL", 8.5);
const d = leg("d", 3, "Yankees ML");

check("same legs: nothing changed", ids(changedLegPickIds([a, b, c], [a, b, c])), []);
check("same legs, another order: nothing changed", ids(changedLegPickIds([a, b, c], [c, a, b])), []);
check("one leg replaced: only it", ids(changedLegPickIds([a, b, c], [a, b, d])), ["d"]);
check("every leg new", ids(changedLegPickIds([a, b], [c, d])), ["c", "d"]);
check("the same bet from another capper is not a change", ids(changedLegPickIds([a, b], [leg("a2", 0, "Yankees ML"), b])), []);
check("a different line on the same game is a change", ids(changedLegPickIds([b], [leg("b2", 1, "Over 9.5", "TOTAL", 9.5)])), ["b2"]);
check("no previous legs: every leg changed", ids(changedLegPickIds([], [a, b])), ["a", "b"]);
check("more legs than before: the added one", ids(changedLegPickIds([a, b], [a, b, c])), ["c"]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
