// Proof for the shared pick tie-break (src/lib/pick-order.ts): every JS sort over
// picks by gameTime/gradedAt gives the SAME answer no matter what order tied
// picks arrive in (findMany without orderBy has no defined order), and agrees
// with the SQL paths' canonical (gameTime, createdAt, id) order.
//
// Pure - no database. Feeds every permutation of a fixture with same-gameTime
// picks (the real-slate shape) through computeStats / computeMomentum /
// recentRecordColumn / the cumulative-units series / the capper-comparison
// preceding-streak sort's comparator, and asserts the output never varies.
//   npx tsx src/lib/pick-order-acceptance-test.ts
import type { Pick } from "@prisma/client";
import { comparePicksChronological, comparePicksChronologicalDesc, comparePicksByGradedAtDesc } from "@/lib/pick-order";
import { computeStats, computeMomentum, recentRecordColumn, computeUnitsChartByPickNumber, computeMaxDrawdown } from "@/server/data/stats";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const T = Date.UTC(2026, 5, 1, 18, 0, 0);
let n = 0;
function pick(status: "WIN" | "LOSS" | "PUSH", gameOffsetH: number, createdOffsetS: number, id: string): Pick {
  n++;
  return {
    id,
    userId: "u",
    capperId: "c",
    sportId: "s",
    homeTeam: "H",
    awayTeam: "A",
    betType: "MONEYLINE",
    betDetail: null,
    odds: n % 2 ? -120 : 150,
    line: null,
    period: "FULL_GAME",
    units: 1 + (n % 3) * 0.5,
    datePosted: new Date(T),
    gameTime: new Date(T + gameOffsetH * 3600000),
    status,
    gradedAt: new Date(T + gameOffsetH * 3600000 + 3600000),
    createdAt: new Date(T + createdOffsetS * 1000),
  } as unknown as Pick;
}

// Ties on gameTime at offsets 1 and 2 (two picks each); createdAt/id break them.
const picks: Pick[] = [
  pick("LOSS", 0, 0, "p-a"),
  pick("WIN", 1, 5, "p-b"),
  pick("LOSS", 1, 3, "p-c"), // same gameTime as p-b, older createdAt -> before it
  pick("WIN", 2, 9, "p-d"),
  pick("WIN", 2, 9, "p-e"), // same gameTime AND createdAt as p-d -> id decides
  pick("WIN", 3, 1, "p-f"),
];

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}
const perms = permutations(picks);

const expectedOrder = ["p-a", "p-c", "p-b", "p-d", "p-e", "p-f"];
check(
  "comparator orders by (gameTime, createdAt, id)",
  JSON.stringify([...picks].sort(comparePicksChronological).map((p) => p.id)) === JSON.stringify(expectedOrder)
);
check(
  "descending comparator is the exact reverse",
  JSON.stringify([...picks].sort(comparePicksChronologicalDesc).map((p) => p.id)) === JSON.stringify([...expectedOrder].reverse())
);

const gradedTied = [pick("WIN", 5, 1, "g-1"), pick("WIN", 5, 4, "g-2"), pick("LOSS", 6, 0, "g-3")];
check(
  "gradedAt comparator: newest first, then createdAt desc, then id desc",
  JSON.stringify([...gradedTied].sort(comparePicksByGradedAtDesc).map((p) => p.id)) === JSON.stringify(["g-3", "g-2", "g-1"])
);

function allSame(label: string, f: (ps: Pick[]) => unknown) {
  const outs = new Set(perms.map((ps) => JSON.stringify(f(ps))));
  check(`${label} is identical across all ${perms.length} input orders`, outs.size === 1, `${outs.size} distinct results`);
}
allSame("computeStats (streaks/units)", computeStats);
allSame("computeMomentum", computeMomentum);
allSame("recentRecordColumn (last 3)", (ps) => recentRecordColumn(ps, 3));
allSame("cumulative units series", computeUnitsChartByPickNumber);
allSame("max drawdown", computeMaxDrawdown);
allSame("gradedAt-desc order", (ps) => [...ps].sort(comparePicksByGradedAtDesc).map((p) => p.id));

// The canonical order pins the actual streak: L, L, W, W, W, W -> current WIN x4.
check("current streak follows the canonical order", computeStats([...picks].reverse()).currentStreak.count === 4);

if (failures > 0) process.exit(1);
console.log("\nAll checks passed.");
