// Who fetches from The Odds API when today's OddsSnapshot row does not exist yet.
//
// The row is keyed by Eastern date, so from midnight ET until something seeds
// it there is nothing to read. Every request path that needs odds (the layout
// ticker on every page load, /live, catalog import) used to fall straight
// through to the paid Odds API fetch on that miss, with nothing coordinating
// them: N concurrent requests across the fleet meant N fetches per sport, each
// one spending credits, all writing the same row.
//
// readSnapshotOrSeed bounds that to about one fetch per sport per claim window:
//
//   1. Cross-instance claim - a token in the shared Next Data Cache keyed by
//      (sport, date, time bucket), the same mechanism page-grading.ts uses for
//      its persist throttle. Only the caller whose claim callback actually ran
//      fetches. Everyone else gets `empty` for this request.
//   2. Per-instance attempt memo - concurrent callers on one instance share the
//      one in-flight attempt, and an attempt that did not seed (claim lost, no
//      API key, fetch failed) is remembered for ODDS_SEED_RETRY_MS so a missing
//      row costs neither a database read nor a claim check on every request.
//
// The cached read itself must THROW OddsSnapshotMissingError for a missing row
// rather than return an empty list: unstable_cache stores whatever its callback
// returns, and a stored "no games" would outlive the seed by the entry's whole
// TTL (10 minutes for the ticker). A thrown error is never stored.
//
// The claim must be taken OUTSIDE any unstable_cache callback. Inside one, Next
// bypasses the Data Cache for nested unstable_cache calls, so every caller's
// claim callback would run and every caller would "win".
//
// Costs, accepted (same as page-grading.ts): two instances that miss the claim
// entry at the same instant both fetch; and after a failed fetch nobody retries
// until the claim window rolls over. The crons do not go through this at all -
// they call the fetch path directly and stay the authoritative attempt.
//
// No imports on purpose, so the acceptance test runs under bare tsx.

export class OddsSnapshotMissingError extends Error {
  constructor(sportKey: string, fetchDate: string) {
    super(`No OddsSnapshot row for ${sportKey} on ${fetchDate}`);
    this.name = "OddsSnapshotMissingError";
  }
}

// By name, not instanceof: the error crosses unstable_cache and possibly a
// bundler chunk boundary on its way back to the caller.
export function isOddsSnapshotMissing(err: unknown): boolean {
  return err instanceof Error && err.name === "OddsSnapshotMissingError";
}

// One fetch attempt per sport per this many seconds, fleet-wide.
export const ODDS_SEED_CLAIM_WINDOW_SECONDS = 60;
// How long one instance remembers "the row is missing and I am not the one
// seeding it" before it looks again. Bounds how long a claim loser shows no
// odds after another instance's seed lands.
export const ODDS_SEED_RETRY_MS = 15_000;

export type OddsSeedDeps<G> = {
  now: () => number;
  // Resolves true for the one caller that should fetch for (sportKey,
  // fetchDate, bucket), false for everyone else in that window.
  claimWindow: (sportKey: string, fetchDate: string, bucket: number, windowSeconds: number) => Promise<boolean>;
  // Fetches and writes today's row. Resolves the games when the row now
  // exists, null when it still does not (no API key, upstream failure).
  seed: (sportKey: string) => Promise<G[] | null>;
};

type Attempt = { at: number; fetchDate: string; seeded: Promise<boolean> };

// Keyed by sport alone so the map stays bounded: a new day's attempt replaces
// the previous day's entry for that sport.
const attempts = new Map<string, Attempt>();

export async function readSnapshotOrSeed<G, T>(args: {
  sportKey: string;
  fetchDate: string;
  // The cached read. Rejects with OddsSnapshotMissingError when the row is missing.
  read: () => Promise<T>;
  // Shapes the freshly seeded games the way `read` would have returned them.
  fromSeeded: (games: G[]) => T;
  empty: T;
  deps: OddsSeedDeps<G>;
  windowSeconds?: number;
  retryMs?: number;
}): Promise<T> {
  const { sportKey, fetchDate, read, fromSeeded, empty, deps } = args;
  const windowSeconds = args.windowSeconds ?? ODDS_SEED_CLAIM_WINDOW_SECONDS;
  const retryMs = args.retryMs ?? ODDS_SEED_RETRY_MS;

  const recentAttempt = (): Attempt | undefined => {
    const a = attempts.get(sportKey);
    return a && a.fetchDate === fetchDate && deps.now() - a.at < retryMs ? a : undefined;
  };
  const readOrMissing = async (): Promise<{ value: T } | null> => {
    try {
      return { value: await read() };
    } catch (err) {
      if (isOddsSnapshotMissing(err)) return null;
      throw err;
    }
  };

  // An attempt already made (or in flight) on this instance that did not seed:
  // the row is still missing, so skip the read and the claim.
  const before = recentAttempt();
  if (before && !(await before.seeded)) return empty;

  const first = await readOrMissing();
  if (first) return first.value;

  // Missing. If an attempt started on this instance while we were reading,
  // join it instead of starting another.
  const racing = recentAttempt();
  if (racing) {
    if (!(await racing.seeded)) return empty;
    const second = await readOrMissing();
    return second ? second.value : empty;
  }

  let games: G[] | null = null;
  const seeded = (async () => {
    const bucket = Math.floor(deps.now() / (windowSeconds * 1000));
    if (!(await deps.claimWindow(sportKey, fetchDate, bucket, windowSeconds))) return false;
    games = await deps.seed(sportKey);
    return games !== null;
  })();
  const attempt: Attempt = { at: deps.now(), fetchDate, seeded };
  attempts.set(sportKey, attempt);
  // A seed that threw is not a verdict about the row - drop it so the next
  // caller on this instance tries again.
  seeded.catch(() => {
    if (attempts.get(sportKey) === attempt) attempts.delete(sportKey);
  });

  return (await seeded) && games !== null ? fromSeeded(games) : empty;
}

/** Test-only: drop every remembered attempt. */
export function __clearOddsSeedAttempts(): void {
  attempts.clear();
}
