import { easternDateKey, startOfEasternDay } from "@/lib/dates";

// The last instant of the Eastern calendar day BEFORE `gameDate`. Passed as
// findLatestAtOrBefore's `asOf`, it means only a snapshot dated strictly
// earlier than the game's own Eastern day can ever be selected - the game's
// own result, and anything else from that same day, can never leak into a
// point-in-time lookup used to score that game. Originally a private helper
// in zone-model.ts (added with the fix for its look-ahead bug); lifted here
// so the starting-pitcher point-in-time reader uses the identical cutoff
// rather than a second copy.
export function dayBefore(gameDate: Date): Date {
  return new Date(startOfEasternDay(gameDate).getTime() - 1);
}

// The most recent snapshot at or before gameDate - `snapshots` must already
// be sorted ascending by snapshotDate (model-evaluation.ts's backtestModel
// preloads every snapshot type that way). Shared by every provider that
// reads a dated snapshot table (team stats, pitcher stats, team tendencies)
// so the "find the value as of this date" logic stays in exactly one place.
export function findLatestAtOrBefore<T extends { snapshotDate: string }>(snapshots: T[], gameDate: Date): T | undefined {
  const key = easternDateKey(gameDate);
  let result: T | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.snapshotDate > key) break;
    result = snapshot;
  }
  return result;
}
