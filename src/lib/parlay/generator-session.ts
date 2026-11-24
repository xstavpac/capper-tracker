// The browser side of the Parlay Generator: holds the last snapshot from
// generateParlayAction (server/actions/parlay-generate.ts) and answers Generate,
// Regenerate and settings changes from it whenever it can.
//
//   - Generate: one draw (generator.ts generateVariation) on the Generate seed in
//     the selection mode, with no exposure penalty. `reseed` (the Generate button)
//     takes a new seed first, so every click gives another first parlay; a settings
//     rebuild keeps the seed, so changing Total legs doesn't reshuffle the card. The
//     pool-defining inputs (league scope, slip picks, targets) unchanged and the
//     snapshot fresh -> the engine runs here on the snapshot. Otherwise one request,
//     carrying the seed and mode, which brings a new snapshot and its parlay built
//     on that draw. Either way the result card restarts: history, shown
//     combinations and exposure.
//   - Regenerate: the engine here with the next seed (fresh per session, so a page
//     load never replays the last one's draws), the selection mode (the card's
//     control, Diversified by default), the card's exposure - how many parlays shown
//     on this card held each bet and game, weighed down (selection.ts) - and every
//     combination this result card has shown (never repeated) - never a request,
//     unless the pool changed or the snapshot went stale (snapshotIsStale: older
//     than ~2 minutes, or a game in it is over or, off the targets and the slip,
//     has kicked off), in which case it reloads first and draws from the new pool.
//   - Refresh: always one request - a fresh snapshot (picks, odds, records) and its
//     parlay on the current Generate seed, whatever the pool and the snapshot's age.
//     Restarts the result card like Generate.
//   - Leg count, max per game, Include Picks, Pick Mix and Fill from don't
//     change the pool, so they never cause a request - only a rebuild.
//
// Nothing is kept between page loads: the exposure is this result card's, in memory.
//
// Hedge and Contrarian come with every build (GeneratedParlay.hedge /
// .contrarian), so showing them is never a request either.
//
// Swapping one leg by hand (the leg's Swap modal: swapOptions / swapLeg) runs
// on the held snapshot too - never a request, even once the snapshot is stale
// (a game that started since is offered only where a build would offer it).
// Only that leg changes; the Regenerate history is left alone.
//
// Client-safe: no React, no server imports at runtime - the action is passed
// in, so a test can count what it does.
import {
  applyLegSwap,
  buildGeneratedParlay,
  generateVariation,
  historyGameKeysOf,
  legSwapOptions,
  snapshotIsStale,
  type GenerateDraw,
  type GeneratedParlay,
  type GeneratorSettings,
  type GeneratorSnapshot,
  type LegSwapOptions,
  type Variation,
} from "@/lib/parlay/generator";
import type { ParlayRejection } from "@/lib/parlay/leg-cap";
import { traceModeOf, traceSettings } from "@/lib/parlay/generator-trace";
import { normalizeIncludeLive } from "@/lib/parlay/include-live";
import { isStarted } from "@/lib/parlay/game-progress";
import { standardScoringVersion, TraceCollector, type RunTrace } from "@/lib/parlay/run-trace";
import { addExposure, DEFAULT_SELECTION_MODE, deriveSeed, freshSeed, NO_EXPOSURE, type Exposure, type SelectionMode } from "@/lib/parlay/selection";

export type PoolInputs = {
  leagues: string[];
  slipPickIds: string[];
  targets: { gameId: string; leagueName: string }[];
};

// `draw`: the Generate's seed and mode, so the server builds the same parlay this session would.
export type GenerateCall = (request: PoolInputs & { settings: GeneratorSettings; draw?: GenerateDraw }) => Promise<{ snapshot: GeneratorSnapshot; parlay: GeneratedParlay } | ParlayRejection>;

// Generate / Refresh: the mode to draw in (the session's default when absent), and whether to take a
// new Generate seed first (the Generate button; a settings rebuild keeps the seed).
export type GenerateOptions = { mode?: SelectionMode; reseed?: boolean };

// Order-free: the same leagues, picks and targets in another order are the same pool.
export function poolKey(inputs: PoolInputs): string {
  const sorted = (xs: string[]) => [...xs].sort().join(",");
  return [sorted(inputs.leagues), sorted(inputs.slipPickIds), sorted(inputs.targets.map((t) => t.leagueName + ":" + t.gameId))].join("|");
}

// How many shown parlays Regenerate remembers (`history`: the newest is what a Regenerate's
// "legs changed" is counted against). Every parlay shown on the card counts toward the
// exposure and the shown combinations, however many.
const HISTORY_KEPT = 20;

export type SessionResult = { parlay: GeneratedParlay; fetched: boolean } | ParlayRejection;

// `onTrace` (diagnostics only, run-trace.ts) receives the trace of every build the engine runs here, in the
// browser; a build that came back from the server was traced there. It never affects a build: the trace is
// written to, never read from, and a throwing handler is ignored.
// `firstSeed` (tests): the session's seed; absent, a fresh one (crypto). Every Generate and Regenerate seed derives from it.
export function createGeneratorSession(deps: { generate: GenerateCall; now?: () => Date; firstSeed?: number; mode?: SelectionMode; onTrace?: (trace: RunTrace) => void }) {
  const now = deps.now ?? (() => new Date());
  let snapshot: GeneratorSnapshot | null = null;
  let key: string | null = null;
  let history: string[][] = [];
  // Fresh per session (crypto): two page loads draw different parlays. Tests pass firstSeed.
  const baseSeed = (deps.firstSeed ?? freshSeed()) >>> 0;
  // Regenerate's seed (the next one each time), and the Generate seed (a new one per reseed).
  let seed = baseSeed;
  let generates = 0;
  let generateSeed = deriveSeed(baseSeed, "generate:0");
  const defaultMode = deps.mode ?? DEFAULT_SELECTION_MODE;
  // This result card: every combination shown (never repeated), and how many parlays shown on it held
  // each bet and game (the exposure). In memory only; reset by Generate / Refresh.
  let shown = new Set<string>();
  let exposure: Exposure = NO_EXPOSURE;
  let requests = 0;

  // The legs a Regenerate varies: the generated ones, or the slip picks drawn
  // under Your picks only with more picks than legs (historyIds, generator.ts).
  const remember = (p: GeneratedParlay) => {
    history = [p.historyIds, ...history].slice(0, HISTORY_KEPT);
    shown.add(p.generatedKey);
    exposure = addExposure(exposure, p.historyBetKeys ?? [], historyGameKeysOf(p));
  };
  const resetCard = () => {
    history = [];
    shown = new Set();
    exposure = NO_EXPOSURE;
  };
  // The Generate draw for these options: a new seed first when asked.
  const generateDraw = (opts: GenerateOptions): GenerateDraw => {
    if (opts.reseed) generateSeed = deriveSeed(baseSeed, "generate:" + ++generates);
    return { seed: generateSeed, mode: opts.mode ?? defaultMode };
  };

  async function load(inputs: PoolInputs, settings: GeneratorSettings, draw?: GenerateDraw): Promise<{ snapshot: GeneratorSnapshot; parlay: GeneratedParlay } | ParlayRejection> {
    requests++;
    const res = await deps.generate({ ...inputs, settings, ...(draw ? { draw } : {}) });
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
        trigger: variation && !variation.generate ? "REGENERATE" : "GENERATE",
        origin: "CLIENT",
        scoringVersion: standardScoringVersion(),
        settings: traceSettings(inputs, settings),
      },
      !variation || variation.generate === true
    );
    const emit = () => {
      try {
        deps.onTrace!(trace.finish());
      } catch {
        // Diagnostics only.
      }
    };
    try {
      const parlay = buildGeneratedParlay(snapshot!, settings, variation, now(), trace);
      trace.extras({ snapshotBuiltAt: snapshot!.builtAt });
      emit();
      return parlay;
    } catch (err) {
      trace.error("ENGINE_ERROR", err);
      emit();
      throw err;
    }
  }

  // "Include live games" turned on after a snapshot loaded with it off: that snapshot has no live prices, so reload.
  const livePricesMissing = (settings: GeneratorSettings) => normalizeIncludeLive(settings.includeLive) && snapshot !== null && snapshot.livePricing?.asked === false && snapshot.games.some((g) => isStarted(g, now()));
  const usable = (inputs: PoolInputs, settings: GeneratorSettings) =>
    snapshot !== null && key === poolKey(inputs) && !snapshotIsStale(snapshot, now()) && !livePricesMissing(settings);

  return {
    // A first parlay for these inputs and settings: one draw on the Generate seed (`reseed`: a new one first).
    async generate(inputs: PoolInputs, settings: GeneratorSettings, opts: GenerateOptions = {}): Promise<SessionResult> {
      resetCard();
      const draw = generateDraw(opts);
      if (usable(inputs, settings)) {
        const parlay = build(inputs, settings, generateVariation(draw));
        remember(parlay);
        return { parlay, fetched: false };
      }
      const res = await load(inputs, settings, draw);
      if ("error" in res) return res;
      remember(res.parlay);
      return { parlay: res.parlay, fetched: true };
    },

    // A fresh snapshot, whether or not the held one is still usable.
    async refresh(inputs: PoolInputs, settings: GeneratorSettings, opts: GenerateOptions = {}): Promise<SessionResult> {
      resetCard();
      const res = await load(inputs, settings, generateDraw(opts));
      if ("error" in res) return res;
      remember(res.parlay);
      return { parlay: res.parlay, fetched: true };
    },

    // Another parlay of comparable strength.
    // `mode` (Best / Diversified / Explore) applies to this Regenerate only; absent, the session's default.
    async regenerate(inputs: PoolInputs, settings: GeneratorSettings, mode: SelectionMode = defaultMode): Promise<SessionResult> {
      let fetched = false;
      if (!usable(inputs, settings)) {
        const res = await load(inputs, settings);
        if ("error" in res) return res;
        fetched = true;
      }
      seed = (seed + 1) >>> 0;
      const parlay = build(inputs, settings, { seed, history, mode, exposure, shown: Array.from(shown) });
      if (parlay.variety !== "NO_ALTERNATIVE") remember(parlay);
      return { parlay, fetched };
    },

    // Leg `legIndex`'s Swap modal: Primary / Hedge / Contrarian / Other games, best first. Empty with no snapshot.
    swapOptions(parlay: GeneratedParlay, legIndex: number, settings: GeneratorSettings): LegSwapOptions {
      if (!snapshot) return { PRIMARY: [], HEDGE: [], CONTRARIAN: [], OTHER_GAMES: [] };
      return legSwapOptions(snapshot, settings, parlay.legs, legIndex, now());
    },

    // The parlay with that leg replaced by `pickId` (one of its swap options), or null.
    swapLeg(parlay: GeneratedParlay, legIndex: number, pickId: string, settings: GeneratorSettings): GeneratedParlay | null {
      if (!snapshot) return null;
      return applyLegSwap(snapshot, settings, parlay, legIndex, pickId, now());
    },

    // For the UI and tests: how many requests this session has made.
    requestCount: () => requests,
    snapshot: () => snapshot,
  };
}
