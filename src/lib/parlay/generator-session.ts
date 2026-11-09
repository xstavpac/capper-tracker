// The browser side of the Parlay Generator: holds the last snapshot from
// generateParlayAction (server/actions/parlay-generate.ts) and answers Generate,
// Regenerate and settings changes from it whenever it can.
//
//   - Generate: the pool-defining inputs (league scope, slip picks, targets)
//     unchanged and the snapshot fresh -> the engine runs here on the snapshot
//     (deterministic: the same Primary). Otherwise one request, which brings a
//     new snapshot and its Primary. Either way the Regenerate history restarts.
//   - Regenerate: the engine here with the next seed (the first one fresh per
//     session, so a page load never replays the last one's draws), the
//     selection mode (the card's control, Diversified by default), the last few
//     parlays' legs to weigh down, and every combination this result card has
//     shown (Your picks only never repeats one) and the history of
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
// Swapping one leg by hand (the leg's swap tray: alternatives / swapLeg) runs
// on the held snapshot too - never a request, even once the snapshot is stale
// (a game that started since is offered only where a build would offer it).
// Hedge and Contrarian are rebuilt for the new legs with the seed and mode of
// the build on screen; the Regenerate history is left alone.
//
// Client-safe: no React, no server imports at runtime - the action is passed
// in, so a test can count what it does.
import { applyLegSwap, buildGeneratedParlay, GENERATOR_RULES, legAlternatives, snapshotIsStale, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot, type LegAlternatives, type Variation } from "@/lib/parlay/generator";
import type { ParlayRejection } from "@/lib/parlay/leg-cap";
import { traceModeOf, traceSettings } from "@/lib/parlay/generator-trace";
import { standardScoringVersion, TraceCollector, type RunTrace } from "@/lib/parlay/run-trace";
import { DEFAULT_SELECTION_MODE, freshSeed, type RecentLeg, type SelectionMode } from "@/lib/parlay/selection";
import { mergeRecentLegs, readReuseHistory, recordReuseHistory, type KeyValueStore } from "@/lib/parlay/reuse-history";

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
// The parlays whose legs the next Regenerate weighs down (selection.ts reuse penalty).
export const RECENT_PARLAYS_PENALIZED = 3;

export type SessionResult = { parlay: GeneratedParlay; fetched: boolean } | ParlayRejection;

// `onTrace` (diagnostics only, run-trace.ts) receives the trace of every build the engine runs here, in the
// browser; a build that came back from the server was traced there. It never affects a build: the trace is
// written to, never read from, and a throwing handler is ignored.
// `reuse` (reuse-history.ts): the user whose browser-kept history of recent parlays joins the session's own in
// recentLegs. `store` is for tests; absent, localStorage (best-effort, never throws).
export function createGeneratorSession(deps: { generate: GenerateCall; now?: () => Date; firstSeed?: number; mode?: SelectionMode; onTrace?: (trace: RunTrace) => void; reuse?: { userId: () => string; store?: KeyValueStore | null } }) {
  const now = deps.now ?? (() => new Date());
  let snapshot: GeneratorSnapshot | null = null;
  let key: string | null = null;
  let history: string[][] = [];
  // Fresh per session (crypto): two page loads draw different Regenerates. Tests pass firstSeed.
  let seed = deps.firstSeed ?? freshSeed();
  const defaultMode = deps.mode ?? DEFAULT_SELECTION_MODE;
  // This result card: every combination shown (Your picks only never repeats one), and the
  // last few parlays' legs with when they were shown. In memory only; reset by Generate / Refresh.
  let shown = new Set<string>();
  let recent: RecentLeg[][] = [];
  let requests = 0;
  // The seed and mode of the build on screen (null: a Generate / Refresh), for a hand swap's Hedge / Contrarian.
  let shownVariation: Pick<Variation, "seed" | "mode"> | null = null;

  // The legs a Regenerate varies: the generated ones, or the slip picks drawn
  // under Your picks only with more picks than legs (historyIds, generator.ts).
  const remember = (p: GeneratedParlay) => {
    history = [p.historyIds, ...history].slice(0, HISTORY_KEPT);
    shown.add(p.generatedKey);
    const at = now().getTime();
    recent = [(p.historyBetKeys ?? []).map((betKey) => ({ betKey, at })), ...recent].slice(0, RECENT_PARLAYS_PENALIZED);
    if (deps.reuse && (p.historyBetKeys ?? []).length > 0) recordReuseHistory(deps.reuse.userId(), p.historyBetKeys!, at, deps.reuse.store);
  };
  // The session's last few parlays plus the browser-kept ones (24h, 10), one entry per leg.
  const recentLegs = (): RecentLeg[] =>
    mergeRecentLegs(recent.flat(), deps.reuse ? readReuseHistory(deps.reuse.userId(), now().getTime(), deps.reuse.store) : []);
  const resetCard = () => {
    shownVariation = null;
    history = [];
    shown = new Set();
    recent = [];
  };

  async function load(inputs: PoolInputs, settings: GeneratorSettings): Promise<{ snapshot: GeneratorSnapshot; parlay: GeneratedParlay } | ParlayRejection> {
    requests++;
    const res = await deps.generate({ ...inputs, settings });
    if ("error" in res) return res;
    snapshot = res.snapshot;
    key = poolKey(inputs);
    return res;
  }

  // The engine on the held snapshot, traced when someone is listening. Regenerate keeps counts only.
  function build(inputs: PoolInputs, settings: GeneratorSettings, variation: Variation | null): GeneratedParlay {
    if (!deps.onTrace) return buildGeneratedParlay(snapshot!, settings, variation, now());
    const trace = new TraceCollector(
      {
        mode: traceModeOf(inputs, settings),
        trigger: variation ? "REGENERATE" : "GENERATE",
        origin: "CLIENT",
        scoringVersion: standardScoringVersion(GENERATOR_RULES),
        settings: traceSettings(inputs, settings),
      },
      !variation
    );
    const emit = () => {
      try {
        deps.onTrace!(trace.finish());
      } catch {
        // Diagnostics only.
      }
    };
    try {
      const parlay = buildGeneratedParlay(snapshot!, settings, variation, now(), GENERATOR_RULES, trace);
      trace.extras({ snapshotBuiltAt: snapshot!.builtAt });
      emit();
      return parlay;
    } catch (err) {
      trace.error("ENGINE_ERROR", err);
      emit();
      throw err;
    }
  }

  const usable = (inputs: PoolInputs) => snapshot !== null && key === poolKey(inputs) && !snapshotIsStale(snapshot, now());

  return {
    // The Primary for these inputs and settings.
    async generate(inputs: PoolInputs, settings: GeneratorSettings): Promise<SessionResult> {
      resetCard();
      if (usable(inputs)) {
        const parlay = build(inputs, settings, null);
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
      resetCard();
      const res = await load(inputs, settings);
      if ("error" in res) return res;
      remember(res.parlay);
      return { parlay: res.parlay, fetched: true };
    },

    // Another parlay of comparable strength.
    // `mode` (Best / Diversified / Explore) applies to this Regenerate only; absent, the session's default.
    async regenerate(inputs: PoolInputs, settings: GeneratorSettings, mode: SelectionMode = defaultMode): Promise<SessionResult> {
      let fetched = false;
      if (!usable(inputs)) {
        const res = await load(inputs, settings);
        if ("error" in res) return res;
        fetched = true;
      }
      seed = (seed + 1) >>> 0;
      const parlay = build(inputs, settings, { seed, history, mode, recentLegs: recentLegs(), shown: Array.from(shown) });
      if (parlay.variety !== "NO_ALTERNATIVE") {
        remember(parlay);
        shownVariation = { seed, mode };
      }
      return { parlay, fetched };
    },

    // Leg `legIndex`'s swap tray: This game / Other games, best first. Empty with no snapshot.
    alternatives(parlay: GeneratedParlay, legIndex: number, settings: GeneratorSettings): LegAlternatives {
      if (!snapshot) return { thisGame: [], otherGames: [] };
      return legAlternatives(snapshot, settings, parlay.legs, legIndex, now());
    },

    // The parlay with that leg replaced by `pickId` (one of its alternatives), or null.
    swapLeg(parlay: GeneratedParlay, legIndex: number, pickId: string, settings: GeneratorSettings): GeneratedParlay | null {
      if (!snapshot) return null;
      return applyLegSwap(snapshot, settings, parlay, legIndex, pickId, now(), shownVariation);
    },

    // For the UI and tests: how many requests this session has made.
    requestCount: () => requests,
    snapshot: () => snapshot,
  };
}
