// Proof for the on-view grading trigger (lib/gradeable-picks.ts): which loaded
// picks make a page ask for grading after paint, and that the trigger agrees
// with the ledger's own "Grading" phase.
//
// Pure. Run with:
//   npx tsx src/lib/gradeable-picks-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { gradeablePicks, type GradeablePickInput } from "@/lib/gradeable-picks";
import { pickPhase } from "@/lib/pick-display";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const MLB = "baseball_mlb";
const NFL = "americanfootball_nfl";
const pick = (over: Partial<GradeablePickInput> & { id: string }): GradeablePickInput => ({
  sportKey: MLB,
  status: "PENDING",
  hasFinalResult: false,
  feedStatus: null,
  ...over,
});

// Nothing loaded, nothing to grade.
expect("no picks", gradeablePicks([]), { sportKeys: [], dueKey: "" });

// The cases that must NOT trigger grading.
expect(
  "not started / live / delayed / no feed status: nothing gradeable",
  gradeablePicks([
    pick({ id: "a", feedStatus: null }),
    pick({ id: "b", feedStatus: "live" }),
    pick({ id: "c", feedStatus: "preview" }),
  ]),
  { sportKeys: [], dueKey: "" }
);
expect(
  "already graded picks never trigger, even with a final result",
  gradeablePicks(["WIN", "LOSS", "PUSH", "CANCELLED"].map((status, i) => pick({ id: "g" + i, status, hasFinalResult: true }))),
  { sportKeys: [], dueKey: "" }
);
expect(
  "a sport with no score source never triggers",
  gradeablePicks([pick({ id: "a", sportKey: null, hasFinalResult: true, feedStatus: "final" })]),
  { sportKeys: [], dueKey: "" }
);

// The two ways a game is known to be over.
expect("pending + game_results row", gradeablePicks([pick({ id: "a", hasFinalResult: true })]).sportKeys, [MLB]);
expect("pending + feed says final", gradeablePicks([pick({ id: "a", feedStatus: "final" })]).sportKeys, [MLB]);

// Only the sports that have something gradeable, each once, first-seen order.
expect(
  "sport keys: distinct, only gradeable sports, first-seen order",
  gradeablePicks([
    pick({ id: "a", sportKey: NFL, feedStatus: "live" }),
    pick({ id: "b", sportKey: MLB, feedStatus: "final" }),
    pick({ id: "c", sportKey: MLB, hasFinalResult: true }),
    pick({ id: "d", sportKey: NFL, hasFinalResult: true }),
  ]).sportKeys,
  [MLB, NFL]
);

// dueKey: identity of the gradeable set.
const setA = gradeablePicks([pick({ id: "a", hasFinalResult: true }), pick({ id: "b", hasFinalResult: true })]);
const setAReordered = gradeablePicks([pick({ id: "b", hasFinalResult: true }), pick({ id: "a", hasFinalResult: true })]);
const setAPlusNoise = gradeablePicks([
  pick({ id: "a", hasFinalResult: true }),
  pick({ id: "b", hasFinalResult: true }),
  pick({ id: "z", feedStatus: "live" }),
]);
const setB = gradeablePicks([pick({ id: "a", hasFinalResult: true }), pick({ id: "c", hasFinalResult: true })]);
const setSmaller = gradeablePicks([pick({ id: "a", hasFinalResult: true })]);
expect("dueKey is non-empty when something is gradeable", setA.dueKey.length > 0, true);
expect("dueKey ignores pick order", setAReordered.dueKey, setA.dueKey);
expect("dueKey ignores non-gradeable picks", setAPlusNoise.dueKey, setA.dueKey);
expect("dueKey changes when a different pick is gradeable", setB.dueKey === setA.dueKey, false);
expect("dueKey changes when a pick leaves the set (it was graded)", setSmaller.dueKey === setA.dueKey, false);

// Agreement with the ledger: a pick triggers grading exactly when the ledger
// shows it as "Grading" (for a sport that can be scored).
{
  const now = new Date("2026-10-07T20:00:00Z");
  let mismatches = 0;
  let n = 0;
  for (const status of ["PENDING", "WIN", "LOSS", "PUSH", "CANCELLED"]) {
    for (const hasFinalResult of [true, false]) {
      for (const feedStatus of ["preview", "live", "final", null] as const) {
        for (const startOffsetH of [-30, -3, 3]) {
          const gameTime = new Date(now.getTime() + startOffsetH * 3600_000);
          const phase = pickPhase({ status, gameTime, now, hasFinalResult, feedStatus });
          const triggers = gradeablePicks([{ id: "x", sportKey: MLB, status, hasFinalResult, feedStatus }]).sportKeys.length > 0;
          n++;
          if (triggers !== (phase === "grading")) mismatches++;
        }
      }
    }
  }
  expect(`trigger === ledger "grading" phase across ${n} combinations`, mismatches, 0);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll passed");
