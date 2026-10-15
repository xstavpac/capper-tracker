// The parts of Auto-Generate's Primary + alternates (alternates.ts) that the
// /parlay client needs too. Client-safe: no imports - alternates.ts itself
// reaches server/data through auto-generate.ts.

// What Auto-Generate is told about the Parlay slip: ids only.
export type SlipHint = {
  picks: { pickId: string; locked: boolean }[];
  games: { gameId: string; locked: boolean }[];
};

export const EMPTY_SLIP: SlipHint = { picks: [], games: [] };

// Order-free identity of a parlay's leg set.
export function legSetKey(pickIds: readonly string[]): string {
  return [...pickIds].sort().join(",");
}

export const NO_MORE_DISTINCT = "No more distinct parlays with these settings";
