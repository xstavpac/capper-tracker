// The one JS comparator for ordering picks chronologically. Mirrors the SQL
// paths' canonical tie-break - ORDER / ORDER_DESC in
// server/data/capper-list-aggregates.ts: (gameTime, createdAt, id COLLATE "C").
//
// Sorting on gameTime alone leaves ties (same-game picks, a capper's picks on
// one slate) in whatever order the caller happened to fetch them, and
// findMany without an orderBy has no defined order - so streaks, "last N"
// windows and the cumulative-units series could disagree with the SQL
// aggregates, and change with the table's physical row order. Every JS sort
// over picks by gameTime/gradedAt goes through here so there is one tie-break,
// not several.
//
// id is compared by UTF-16 code unit, which equals COLLATE "C" (byte order)
// for the ASCII ids (cuid / uuid) picks use.
type ChronoPick = { gameTime: Date; createdAt: Date; id: string };
type GradedPick = { gradedAt: Date | null; createdAt: Date; id: string };

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Oldest -> newest.
export function comparePicksChronological(a: ChronoPick, b: ChronoPick): number {
  return a.gameTime.getTime() - b.gameTime.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || cmpId(a.id, b.id);
}

// Newest -> oldest; exactly the reverse of comparePicksChronological.
export function comparePicksChronologicalDesc(a: ChronoPick, b: ChronoPick): number {
  return comparePicksChronological(b, a);
}

// Most-recently-graded first. A pick with no gradedAt sorts as epoch 0, the
// same as the panels' original `?.getTime() ?? 0`.
export function comparePicksByGradedAtDesc(a: GradedPick, b: GradedPick): number {
  return (
    (b.gradedAt?.getTime() ?? 0) - (a.gradedAt?.getTime() ?? 0) ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    cmpId(b.id, a.id)
  );
}
