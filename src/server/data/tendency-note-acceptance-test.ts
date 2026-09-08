// The Charts note for a team-tendency variable (Win% as favorite / underdog,
// Over / Under rate): readTendencySample turns a snapshot row's raw counts
// into the record + game count, and historyNoteState turns that into the
// finished note string. Proves the rate is shown at ANY sample size with its
// real record, and that the genuine-zero case reports the real absence rather
// than a snapshot-day count.
//
// Pure (no DB, no DOM). Run with:
//   npx tsx src/server/data/tendency-note-acceptance-test.ts
import { readTendencySample, type TendencySplitCounts } from "@/server/data/providers/tendency-provider";
import { historyNoteState } from "@/lib/history-note-state";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

function counts(over: Partial<TendencySplitCounts> = {}): TendencySplitCounts {
  return {
    favWins: 0, favLosses: 0, favPushes: 0,
    dogWins: 0, dogLosses: 0, dogPushes: 0,
    overCount: 0, underCount: 0, totalPushCount: 0,
    ...over,
  };
}

// The real Padres underdog line from the investigation: 6-6 over 12 games, a
// sample the old 20-game floor would have suppressed entirely.
{
  const row = counts({ dogWins: 6, dogLosses: 6, favWins: 14, favLosses: 6 });
  const sample = readTendencySample(row, "tendency_dog_win_pct");
  expect("dog sample: record + real count, no floor", sample, {
    phrase: "as underdog", wins: 6, losses: 6, pushes: 0, games: 12, pct: 0.5,
  });
  expect(
    "dog note: rate shown next to real record and count",
    historyNoteState({ totalSnapshotDays: 28, daysAvailable: 12, tendencySample: sample ?? undefined }),
    { kind: "tendency", label: "50% (6-6) as underdog · 12 games" }
  );
}

// One game is enough - the count itself is the disclosure.
{
  const sample = readTendencySample(counts({ favWins: 1 }), "tendency_fav_win_pct");
  expect(
    "one favorite game -> 100% (1-0), singular 'game'",
    historyNoteState({ totalSnapshotDays: 3, daysAvailable: 1, tendencySample: sample ?? undefined }),
    { kind: "tendency", label: "100% (1-0) as favorite · 1 game" }
  );
}

// Pushes: shown in the record, counted in the total, excluded from the %.
{
  const sample = readTendencySample(counts({ overCount: 11, underCount: 8, totalPushCount: 1 }), "tendency_over_rate");
  expect("over sample carries push in record + total", sample, {
    phrase: "over", wins: 11, losses: 8, pushes: 1, games: 20, pct: 11 / 20,
  });
  expect(
    "over note: W-L-P record form",
    historyNoteState({ totalSnapshotDays: 20, daysAvailable: 20, tendencySample: sample ?? undefined }),
    { kind: "tendency", label: "55% (11-8-1) over · 20 games" }
  );
}

// Genuine zero games in the role: report the real absence, not "28 days".
{
  const sample = readTendencySample(counts({ favWins: 10, favLosses: 8 }), "tendency_dog_win_pct");
  expect("empty dog split -> pct null, games 0", sample, {
    phrase: "as underdog", wins: 0, losses: 0, pushes: 0, games: 0, pct: null,
  });
  expect(
    "empty dog split -> tendency-empty, never a snapshot-day count",
    historyNoteState({ totalSnapshotDays: 28, daysAvailable: 0, tendencySample: sample ?? undefined }),
    { kind: "tendency-empty", phrase: "as underdog" }
  );
}

// No snapshot rows at all in range: still "building", unchanged.
{
  expect(
    "no snapshots yet -> building (tendencySample absent)",
    historyNoteState({ totalSnapshotDays: 0, daysAvailable: 0 }),
    { kind: "building" }
  );
}

// NFL tendency ids resolve through the same path.
{
  const sample = readTendencySample(counts({ dogWins: 2, dogLosses: 1 }), "nfl_tendency_dog_win_pct");
  expect("nfl dog id -> same sample shape", sample, {
    phrase: "as underdog", wins: 2, losses: 1, pushes: 0, games: 3, pct: 2 / 3,
  });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
