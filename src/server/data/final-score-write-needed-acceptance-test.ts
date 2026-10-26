// Proof for finalScoreWriteNeeded, the gate persistFinalScores uses to skip
// rewriting a final whose stored row already matches the feed. Pure: no DB.
// Every case that previously wrote must still write unless the row is
// identical and the fetches had nothing to add.
//   npx tsx src/server/data/final-score-write-needed-acceptance-test.ts
import { finalScoreWriteNeeded } from "@/server/data/grading";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const row = { homeScore: 5, awayScore: 3, inningsCurrent: true };
const base = { existing: row, homeScore: 5, awayScore: 3, identityChange: null, hasBackfill: false, feedInnings: null as unknown };
const change = { sportKey: "baseball_mlb", externalId: "1", gameDate: { from: "a", to: "b" } };

expect("no row yet -> create", finalScoreWriteNeeded({ ...base, existing: undefined }), true);
expect("identical row, nothing new -> skip", finalScoreWriteNeeded(base), false);
expect("home score changed -> write", finalScoreWriteNeeded({ ...base, homeScore: 6 }), true);
expect("away score changed -> write", finalScoreWriteNeeded({ ...base, awayScore: 4 }), true);
expect("a 0-0 stored row against a real score -> write", finalScoreWriteNeeded({ ...base, existing: { ...row, homeScore: 0, awayScore: 0 } }), true);
expect("start time / teams moved -> write", finalScoreWriteNeeded({ ...base, identityChange: change }), true);
expect("a field was backfilled this run -> write", finalScoreWriteNeeded({ ...base, hasBackfill: true }), true);
expect("MLB: feed innings equal the stored blob -> skip", finalScoreWriteNeeded({ ...base, feedInnings: [{ num: 1 }] }), false);
expect("MLB: feed innings differ from (or are missing in) the stored blob -> write", finalScoreWriteNeeded({ ...base, existing: { ...row, inningsCurrent: false }, feedInnings: [{ num: 1 }] }), true);
expect("non-MLB: no feed innings, inningsCurrent ignored", finalScoreWriteNeeded({ ...base, existing: { ...row, inningsCurrent: false } }), false);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
