import { easternDateKey } from "@/lib/dates";

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
