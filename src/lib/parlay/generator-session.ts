// The browser side of the Parlay Generator: holds the last snapshot from
// generateParlayAction (server/actions/parlay-generate.ts) and answers Generate,
// Regenerate and settings changes from it whenever it can.
//
//   - Generate: the pool-defining inputs (league scope, slip picks, targets)
//     unchanged and the snapshot fresh -> the engine runs here on the snapshot
//     (deterministic: the same Primary). Otherwise one request, which brings a
//     new snapshot and its Primary. Either way the Regenerate history restarts.
//   - Regenerate: the engine here with the next seed and the history of
//     parlays shown - never a request, unless the pool changed or the snapshot
//     went stale (snapshotIsStale: older than ~2 minutes, or a game in it is over
//     or, off the targets and the slip, has kicked off), in which case it reloads first and draws from the new pool.
//   - Refresh: always one request - a fresh snapshot (picks, odds, records) and
//     its Primary, whatever the pool and the snapshot's age. Restarts the
//     Regenerate history like Generate.
//   - Leg count, max per game, Include Picks, Pick Mix and Fill from don't
//     change the pool, so they never cause a request - only a rebuild.
//
// Hedge and Contrarian come with every build (GeneratedParlay.hedge /
// .contrarian), so showing them is never a request either.
//
// Client-safe: no React, no server imports at runtime - the action is passed
// in, so a test can count what it does.
import { buildGeneratedParlay, snapshotIsStale, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import type { ParlayRejection } from "@/lib/parlay/leg-cap";

export type PoolInputs = {
  leagues: string[];
  slipPickIds: string[];
  targets: { gameId: string; leagueName: string }[];
};

export type GenerateCall = (request: PoolInputs & { settings: GeneratorSettings }) => Promise<{ snapshot: GeneratorSnapshot; parlay: GeneratedParlay } | ParlayRejection>;

// Order-free: the same leagues, picks and targets in another order are the same pool.
export function poolKey(inputs: PoolInputs): string {
  const sorted = (xs: string[]) => [...xs].sort().join(",");
  return [sorted(inputs.leagues), sorted(inputs.slipPickIds), sorted(inputs.targets.map((t) => t.leagueName + ":" + t.gameId))].join("|");
}

// How many shown parlays Regenerate remembers (the engine weighs down the last
// few of them and never repeats any it can avoid).
const HISTORY_KEPT = 20;

export type SessionResult = { parlay: GeneratedParlay; fetched: boolean } | ParlayRejection;

export function createGeneratorSession(deps: { generate: GenerateCall; now?: () => Date; firstSeed?: number }) {
  const now = deps.now ?? (() => new Date());
  let snapshot: GeneratorSnapshot | null = null;
  let key: string | null = null;
  let history: string[][] = [];
  let seed = deps.firstSeed ?? 1;
  let requests = 0;

  const generatedIds = (p: GeneratedParlay) => p.legs.filter((l) => l.source === "GENERATED").map((l) => l.pick.pickId);
  const remember = (p: GeneratedParlay) => {
    history = [generatedIds(p), ...history].slice(0, HISTORY_KEPT);
  };

  async function load(inputs: PoolInputs, settings: GeneratorSettings): Promise<{ snapshot: GeneratorSnapshot; parlay: GeneratedParlay } | ParlayRejection> {
    requests++;
    const res = await deps.generate({ ...inputs, settings });
    if ("error" in res) return res;
    snapshot = res.snapshot;
    key = poolKey(inputs);
    return res;
  }

  const usable = (inputs: PoolInputs) => snapshot !== null && key === poolKey(inputs) && !snapshotIsStale(snapshot, now());

  return {
    // The Primary for these inputs and settings.
    async generate(inputs: PoolInputs, settings: GeneratorSettings): Promise<SessionResult> {
      history = [];
      if (usable(inputs)) {
        const parlay = buildGeneratedParlay(snapshot!, settings, null, now());
        remember(parlay);
        return { parlay, fetched: false };
      }
      const res = await load(inputs, settings);
      if ("error" in res) return res;
      remember(res.parlay);
      return { parlay: res.parlay, fetched: true };
    },

    // A fresh snapshot, whether or not the held one is still usable.
    async refresh(inputs: PoolInputs, settings: GeneratorSettings): Promise<SessionResult> {
      history = [];
      const res = await load(inputs, settings);
      if ("error" in res) return res;
      remember(res.parlay);
      return { parlay: res.parlay, fetched: true };
    },

    // Another parlay of comparable strength.
    async regenerate(inputs: PoolInputs, settings: GeneratorSettings): Promise<SessionResult> {
      let fetched = false;
      if (!usable(inputs)) {
        const res = await load(inputs, settings);
        if ("error" in res) return res;
        fetched = true;
      }
      seed++;
      const parlay = buildGeneratedParlay(snapshot!, settings, { seed, history }, now());
      if (parlay.variety !== "NO_ALTERNATIVE") remember(parlay);
      return { parlay, fetched };
    },

    // For the UI and tests: how many requests this session has made.
    requestCount: () => requests,
    snapshot: () => snapshot,
  };
}
