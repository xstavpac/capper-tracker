export function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Picks the item in `items` whose getTime() is nearest to `referenceTime` (ms).
// Shared by every "same two teams, which of these games is this" match -
// live scores to odds, resolved nicknames to a schedule game, picks to game results.
export function closestByTime<T>(items: T[], getTime: (item: T) => number, referenceTime: number): T {
  return items.reduce((closest, item) =>
    Math.abs(getTime(item) - referenceTime) < Math.abs(getTime(closest) - referenceTime) ? item : closest
  );
}
