"use client";

// The Parlay Generator: one card, one set of controls, one result (PR 6 of the
// consolidation). Top to bottom:
//   1 · Your Picks and Target Games - the slip's picks by game, each always in
//       the parlay; full slate, or only the games targeted on Live (plus your
//       picks' games).
//   2 · Pick Filters - league scope, Bet Types (All Picks / Moneyline / Spread /
//       Totals / Props) + Customize Mix, max legs per game, minimum capper win
//       rate, Fill from; Total legs leads the settings block.
//   Clear, Generate parlay - and the result under it.
//
// Generate asks the server once (generateParlayAction) for the pool and the
// Primary; Regenerate and every setting that doesn't change the pool run the
// engine here on that pool (generator-session.ts) - no request. Changing the
// pool (picks, targets, leagues) clears the result until the next Generate.
//
// Generate and Regenerate show the result pick by pick (use-build-reveal.ts) -
// the engine's answer as it is, revealed in steps. Settings rebuilds and Refresh
// show it at once, as does prefers-reduced-motion.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { generateParlayAction } from "@/server/actions/parlay-generate";
import { recordGeneratorRunAction } from "@/server/actions/parlay-run-log";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { BoltIcon, DatabaseIcon, GamepadIcon, LayersIcon, TrophyIcon } from "@/components/dashboard/cappers-icons";
import { useParlayPool, type PooledPick } from "@/components/parlay/parlay-pool-context";
import { FilterRow, LABEL, LegStepper, PILL_OUTLINE, PILL_PRIMARY, PillSwitch, ScopeChip, Section, SettingRow, SettingsBlock, StepperControl, TextSegments } from "@/components/parlay/parlay-controls";
import { IncludePicksChips, PickMixControl } from "@/components/parlay/pick-mix-control";
import { HybridControls, HybridResults, ModeToggle, type Mode } from "@/components/parlay/hybrid-mode";
import { useHybridGenerator } from "@/components/parlay/use-hybrid-generator";
import { useBuildReveal } from "@/components/parlay/use-build-reveal";
import { changedLegPickIds } from "@/lib/parlay/changed-legs";
import { formatGameTime, formatOdds, GeneratorResult } from "@/components/parlay/generator-result";
import { StartedLine } from "@/components/parlay/started-line";
import { reconcileMix, selectedCategories, toggleInclude, type PickMix } from "@/lib/parlay/include-picks";
import type { BetCategory } from "@/lib/parlay/bet-category";
import { MAX_LEGS_PER_GAME, MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import { GATE_DEFAULT, GATE_MAX, GATE_MIN, GATE_STEP, normalizeMinWinPct, readStoredGate, writeStoredGate } from "@/lib/parlay/gate";
import { clampManualSlots, disabledFillFrom, effectiveManualSlots, maxManualSlots } from "@/lib/parlay/combined-fill";
import { combinedLegsNote, FILL_FROM_LABELS, FILL_FROM_ORDER, fillFromHelp, NEEDS_PICKS_TITLE, slipSubtitle } from "@/lib/parlay/combined-ui";
import { CombinedMixBox } from "@/components/parlay/combined-mix-box";
import { bestAvailableRecord } from "@/lib/parlay/pick-record";
import { effectiveFillFrom, legRange, legsNote, POOL_OVER_CAP_NOTE, type NoAlternativeReason } from "@/lib/parlay/subset-ui";
import { readStoredMode, writeStoredMode } from "@/lib/parlay/selection-mode-store";
import { DEFAULT_SELECTION_MODE, type SelectionMode } from "@/lib/parlay/selection";
import { createGeneratorSession, poolKey, type PoolInputs } from "@/lib/parlay/generator-session";
import { removedHeading, removedPickText } from "@/lib/parlay/slip-state";
import { FAVORITES_EMPTY, FAVORITES_STAR_LABEL, FAVORITES_SUBTITLE, NO_FAVORITES_SUBTITLE, readStoredFavoritesOnly, writeStoredFavoritesOnly } from "@/lib/parlay/favorites-only";
import { INCLUDE_LIVE_LABEL, readStoredIncludeLive, writeStoredIncludeLive } from "@/lib/parlay/include-live";
import { StarIcon } from "@/components/dashboard/star-icon";
import type { FillFrom, GeneratedParlay, GeneratorSettings } from "@/lib/parlay/generator";

const FILL_FROM_OPTIONS: { key: FillFrom; label: string }[] = FILL_FROM_ORDER.map((key) => ({ key, label: FILL_FROM_LABELS[key] }));
const LINK = "text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400";
const CHIP = "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold";
// The "+ Add ... from Live" links: a filled brand pill, so the way into Live stands out from the quiet text links.
const ADD_FROM_LIVE =
  "inline-flex h-8 items-center rounded-full border border-brand-600 bg-brand-600 px-3.5 text-[13px] font-semibold text-white transition hover:bg-brand-700";

const PILL_BASE = "inline-flex h-8 items-center justify-center rounded-full border px-3.5 text-[13px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";
const CLEAR_PICKS =
  PILL_BASE + " w-full gap-1.5 border-red-500 bg-transparent text-red-600 hover:bg-red-600 hover:text-white focus-visible:ring-red-500 sm:w-auto dark:text-red-400 dark:hover:text-white";
const CLEAR_YES = PILL_BASE + " border-red-600 bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500";
const CLEAR_CANCEL = PILL_BASE + " border-border bg-transparent text-foreground hover:bg-muted focus-visible:ring-brand-600";
const CLEAR_CONFIRM_MS = 5000;

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m5 5v6m4-6v6" />
    </svg>
  );
}

// "Clear Your Picks (N)": the first click asks "Clear N picks?" inline. No answer
// in 5 seconds, or a click elsewhere, puts it back. Hidden with no picks.
function ClearPicksButton({ count, onClear }: { count: number; onClear: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CLEAR_CONFIRM_MS);
    const away = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setConfirming(false);
    };
    document.addEventListener("pointerdown", away);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", away);
    };
  }, [confirming]);
  useEffect(() => {
    if (count === 0) setConfirming(false);
  }, [count]);
  if (count === 0) return null;
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className={CLEAR_PICKS}>
        <TrashIcon className="h-3.5 w-3.5" />
        Clear Your Picks ({count})
      </button>
    );
  }
  return (
    <div ref={ref} role="group" aria-label="Confirm clearing your picks" className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <span className="text-[13px] font-semibold text-foreground">Clear {count} pick{count === 1 ? "" : "s"}?</span>
      <button
        type="button"
        onClick={() => {
          setConfirming(false);
          onClear();
        }}
        className={CLEAR_YES}
      >
        Yes, clear
      </button>
      <button type="button" onClick={() => setConfirming(false)} className={CLEAR_CANCEL}>
        Cancel
      </button>
    </div>
  );
}

// What the page's stat tiles read from the last build.
export type GeneratorSummary = { legs: number; fromSlip: number; generated: number } | null;

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg leading-none text-muted-foreground transition hover:bg-muted hover:text-foreground">
      ×
    </button>
  );
}

// `hasFavorites`: whether the user has favorited any capper (the page reads the cached roster).
export function GeneratorCard({ leagues, hasFavorites = true, onSummary }: { leagues: string[]; hasFavorites?: boolean; onSummary?: (s: GeneratorSummary) => void }) {
  const slip = useParlayPool();
  const { pool, targets, targetedGames, removed, isLeagueInScope, isLeagueLocked, toggleLeague, legCount, setLegCount, userId, generatorFilters, patchGeneratorFilters } = slip;

  // Standard (this card, as ever) or Hybrid (use-hybrid-generator.ts). Each keeps its own state.
  const [mode, setMode] = useState<Mode>("standard");
  const hybridScope = useMemo(
    () => ({ leagues: leagues.filter(isLeagueInScope), targets: targets.map((t) => ({ gameId: t.gameId, leagueName: t.leagueName })) }),
    [leagues, isLeagueInScope, targets]
  );
  const hybrid = useHybridGenerator(hybridScope);

  // Bet types, Pick Mix, Max legs per game and Fill from live in the slip context, not here: this card is
  // unmounted by the trip to Live and back, and the filters must survive it (and the Fill from toggle).
  const { include, mix, maxPerGame, fillFrom: fillFromChoice, manualSplit } = generatorFilters;
  // Rows for the selected categories only; follows the selection (reconcileMix).
  const setMix = (m: PickMix | null) => patchGeneratorFilters({ mix: m });
  const categories = selectedCategories(include);
  function onToggleInclude(key: "ALL" | BetCategory) {
    const next = toggleInclude(include, key);
    patchGeneratorFilters({ include: next, mix: mix && reconcileMix(mix, selectedCategories(next)) });
  }
  const setMaxPerGame = (n: number) => patchGeneratorFilters({ maxPerGame: n });
  const setFillFrom = (v: FillFrom) => patchGeneratorFilters({ fillFrom: v });
  // More than MAX_PARLAY_LEGS picks can only be built as Your picks only (the engine draws the best 25).
  const fillFrom: FillFrom = effectiveFillFrom(pool.length, fillFromChoice);
  const combined = fillFrom === "COMBINED";
  // Combined's split: the slider's, scaled to Total legs (half the legs until moved), 0..min(Total legs, your picks).
  const manualSlots = combined ? effectiveManualSlots(manualSplit, legCount, pool.length) : 0;

  // Remembered per user, apart from the slip. Read after mount so the server and
  // first client render agree.
  const [minWinPct, setMinWinPctState] = useState(GATE_DEFAULT);
  useEffect(() => {
    setMinWinPctState(readStoredGate(userId));
  }, [userId]);
  function setMinWinPct(n: number) {
    const next = normalizeMinWinPct(Math.max(GATE_MIN, Math.min(GATE_MAX, n)));
    setMinWinPctState(next);
    writeStoredGate(userId, next);
  }
  // The Favorites only star - remembered the same way. Standard only: Hybrid never reads it.
  const [favoritesOnly, setFavoritesOnlyState] = useState(false);
  useEffect(() => {
    setFavoritesOnlyState(readStoredFavoritesOnly(userId));
  }, [userId]);
  function toggleFavoritesOnly() {
    const next = !favoritesOnly;
    setFavoritesOnlyState(next);
    writeStoredFavoritesOnly(userId, next);
  }
  // "Include live games" (include-live.ts) - remembered the same way, on by default. Standard only: Hybrid has its own filters.
  const [includeLive, setIncludeLiveState] = useState(true);
  useEffect(() => {
    setIncludeLiveState(readStoredIncludeLive(userId));
  }, [userId]);
  function toggleIncludeLive() {
    const next = !includeLive;
    setIncludeLiveState(next);
    writeStoredIncludeLive(userId, next);
  }
  const [parlay, setParlay] = useState<GeneratedParlay | null>(null);
  // The parlay as the last build made it, before any hand swap: what Reset all puts back.
  const [asBuilt, setAsBuilt] = useState<GeneratedParlay | null>(null);
  const [builtFor, setBuiltFor] = useState<string | null>(null);
  // The settings the shown parlay was built under (all but Total legs): its capacity is only true for them.
  const [builtCapKey, setBuiltCapKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set by a Regenerate that couldn't vary: why (subset-ui.ts). The parlay shown stays.
  const [noAlternative, setNoAlternative] = useState<NoAlternativeReason | null>(null);
  // After a Regenerate: the legs that differ from the parlay shown before it (changed-legs.ts), the only
  // ones that land highlighted. Null after anything else (Generate, a rebuild, Reset all).
  const [changedPickIds, setChangedPickIds] = useState<ReadonlySet<string> | null>(null);
  // The run log (run-trace.ts): the trace of a build made here is sent to the server, fire and forget. It is
  // diagnostics - a failure is ignored and never touches the parlay.
  const session = useRef(
    createGeneratorSession({
      generate: (req) => generateParlayAction(req),
      onTrace: (trace) => void recordGeneratorRunAction(trace).catch(() => undefined),
    })
  );

  const inputs: PoolInputs = useMemo(
    () => ({ leagues: leagues.filter(isLeagueInScope), slipPickIds: pool.map((p) => p.pickId), targets: targets.map((t) => ({ gameId: t.gameId, leagueName: t.leagueName })) }),
    [leagues, isLeagueInScope, pool, targets]
  );
  const settings: GeneratorSettings = useMemo(
    // favoritesOnly only when on, so a build with the star off is the same request as before it existed.
    // includeLive only when off, the same way: a build with the switch on is the request it always was.
    // manualSlots only under Combined: every other build is the request it always was.
    () => ({
      legCount,
      maxLegsPerGame: maxPerGame,
      include,
      mix,
      fillFrom,
      minWinPct,
      ...(favoritesOnly ? { favoritesOnly: true } : {}),
      ...(includeLive ? {} : { includeLive: false }),
      ...(combined ? { manualSlots } : {}),
    }),
    [legCount, maxPerGame, include, mix, fillFrom, minWinPct, favoritesOnly, includeLive, combined, manualSlots]
  );
  const key = poolKey(inputs);

  // The records Your Picks shows beside each pick - the same call the old
  // slip list made, once per change of picks.
  // Best / Diversified / Explore: how Generate and Regenerate draw. Remembered per user, best-effort.
  const [selectionMode, setSelectionModeState] = useState<SelectionMode>(DEFAULT_SELECTION_MODE);
  useEffect(() => {
    setSelectionModeState(readStoredMode(userId));
  }, [userId]);
  function setSelectionMode(m: SelectionMode) {
    setSelectionModeState(m);
    writeStoredMode(userId, m);
  }
  const [records, setRecords] = useState<CapperLeagueRecords | null>(null);
  const picksKey = pool.map((p) => p.pickId).join(",");
  useEffect(() => {
    let cancelled = false;
    if (pool.length === 0) {
      setRecords(null);
      return;
    }
    getLeagueRecordsAction(pool.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }))).then(
      (r) => !cancelled && setRecords(r),
      () => !cancelled && setRecords(null)
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- picksKey stands in for pool
  }, [picksKey]);

  // The pick-by-pick build. `runs` numbers every build: an answer for one that was
  // superseded (a newer build, Clear result, a pool change) is dropped, never shown.
  const build = useBuildReveal();
  const runs = useRef(0);
  // `reseed`: the Generate button - a new draw, so each click gives another first parlay. A settings
  // rebuild keeps the draw's seed (generator-session.ts), so the card doesn't reshuffle on every step.
  async function run(kind: "generate" | "regenerate" | "refresh", animate = false, reseed = false) {
    const run = ++runs.current;
    // A new build ends any sequence still running.
    build.cancel();
    // Generate starts analyzing now, while the server works; Regenerate (no request)
    // once it has its answer, so a Regenerate that changes nothing changes nothing.
    let seq = animate && kind === "generate" ? build.start() : null;
    setBusy(true);
    setError(null);
    try {
      if (kind === "refresh" && (await slip.refreshSlip())) {
        // The slip itself changed (a pick graded, its game over or gone): the notice
        // names it, and the old result no longer describes the slip.
        return;
      }
      const res =
        kind === "refresh"
          ? await session.current.refresh(inputs, settings, { mode: selectionMode })
          : kind === "generate"
            ? await session.current.generate(inputs, settings, { mode: selectionMode, reseed })
            : await session.current.regenerate(inputs, settings, selectionMode);
      if (run !== runs.current) return;
      if ("error" in res) {
        build.cancel();
        setError(res.error);
        return;
      }
      if (kind === "regenerate" && res.parlay.variety === "NO_ALTERNATIVE") {
        setNoAlternative(res.parlay.noAlternativeReason ?? "NO_COMPARABLE");
        return;
      }
      if (animate && kind === "regenerate") seq = build.start();
      setNoAlternative(null);
      setChangedPickIds(kind === "regenerate" && parlay ? changedLegPickIds(parlay.legs, res.parlay.legs) : null);
      setParlay(res.parlay);
      setAsBuilt(res.parlay);
      setBuiltFor(key);
      setBuiltCapKey(capKey);
      // Zero legs: the empty state as ever, no sequence.
      if (seq !== null && res.parlay.legs.length > 0) build.land(seq, res.parlay.legs.length);
      else build.cancel();
    } catch {
      if (run !== runs.current) return;
      build.cancel();
      setError("Couldn't generate a parlay right now - try again.");
    } finally {
      if (run === runs.current) setBusy(false);
    }
  }

  // A different pool: the result no longer describes it. The same pool with
  // other settings: the best parlay for them, rebuilt here (no request).
  const settingsKey = JSON.stringify(settings);
  // What the engine's capacity depends on: every setting but Total legs (it only chooses how many of the capacity are used).
  const capKey = JSON.stringify({ ...settings, legCount: 0 });
  useEffect(() => {
    if (!parlay) return;
    if (builtFor !== key) {
      setParlay(null);
      setNoAlternative(null);
      return;
    }
    // A settings rebuild: shown at once (and it ends any build still revealing).
    void run("generate");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reruns on the pool or the settings changing, nothing else
  }, [key, settingsKey]);

  // A different pool also ends a build in progress, its answer included.
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    if (!build.reveal) return;
    runs.current++;
    build.cancel();
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a pool change only
  }, [key]);

  useEffect(() => {
    onSummary?.(parlay ? { legs: parlay.legs.length, fromSlip: parlay.fromSlip, generated: parlay.generated } : null);
  }, [parlay, onSummary]);

  function clear() {
    // Ends any build in progress; an answer still on its way is dropped.
    runs.current++;
    build.cancel();
    setBusy(false);
    setParlay(null);
    setBuiltFor(null);
    setBuiltCapKey(null);
    setError(null);
    setNoAlternative(null);
  }

  // The leg count: 1 to the cap in every Fill from - the slip is a pool, never a floor. Once a build
  // has said what the pool holds, never more than it can supply.
  const yourPicksOnly = fillFrom === "YOUR_PICKS_ONLY";
  const built = parlay && builtFor === key ? parlay : null;
  // Recomputed from the current settings: a parlay built under other settings (Fill from, Bet types, ...) says nothing
  // about what these can supply, so until the rebuild lands the ceiling is the cap, never a stale capacity.
  const capacity = built && builtCapKey === capKey ? built.capacity : MAX_PARLAY_LEGS;
  const { min: minLegs, max: maxLegs } = legRange({ capacity });

  // Your picks, by game, in the order they were added.
  const byGame = useMemo(() => {
    const groups = new Map<string, PooledPick[]>();
    for (const p of pool) groups.set(p.gameId, [...(groups.get(p.gameId) ?? []), p]);
    return Array.from(groups.values());
  }, [pool]);
  // Per-pick notes for the drops that name a reason (a duplicate, a conflict, a per-game cap). The picks
  // a smaller Total legs left out are one collapsed line in the result instead (subset-ui.ts).
  const droppedNote = new Map((built ? built.dropped.filter((d) => d.reason !== "not_selected") : []).map((d) => [d.pickId, d.note]));
  const targetLabel = new Map(targets.map((t) => [t.gameId, t.gameLabel]));

  const modeToggle = <ModeToggle mode={mode} onChange={setMode} />;
  if (mode === "hybrid") {
    return (
      <>
        <HybridControls
          gen={hybrid}
          leagues={leagues}
          isLeagueInScope={isLeagueInScope}
          isLeagueLocked={isLeagueLocked}
          toggleLeague={toggleLeague}
          targetedGames={targetedGames}
          onToggleTarget={slip.toggleTarget}
          onClearTargets={slip.clearTargets}
          canGenerate={hybridScope.leagues.length > 0 || hybridScope.targets.length > 0}
          modeToggle={modeToggle}
        />
        <HybridResults gen={hybrid} />
      </>
    );
  }

  const hasPicksBody = slip.clearedCount > 0 || pool.length > 0 || Boolean(removed) || targets.length > 0 || slip.leagueRemoved !== null;

  return (
    <>
      <PanelShell
        theme={{
          ...TINTS.neutral,
          card: "glass-card p-3.5",
          title: "Parlay Generator",
          subtitle: "Build parlays using your picks or target games. The rest are the best qualified picks from your cappers.",
          icon: <BoltIcon className="h-[17px] w-[17px] stroke-[2.2]" />,
        }}
        footer={undefined}
        wrapSubtitle
      >
        {modeToggle}

        {/* 1 · Your picks and target games */}
        <Section
          n={1}
          tone="green"
          title="Your Picks and Target Games"
          description={slipSubtitle(pool.length)}
          actions={
            <>
              <ClearPicksButton count={pool.length} onClear={slip.clearSlip} />
              <Link href="/live" onClick={slip.enterSlipMode} className={ADD_FROM_LIVE}>
                + Add picks from Live
              </Link>
              <Link href="/live" onClick={slip.enterSlipMode} className={ADD_FROM_LIVE}>
                + Add games from Live
              </Link>
            </>
          }
        >
          {hasPicksBody && (
            <div className="space-y-3">
              {slip.clearedCount > 0 && (
                <p className="text-xs font-medium text-muted-foreground">
                  Cleared {slip.clearedCount} pick{slip.clearedCount === 1 ? "" : "s"}.{" "}
                  <button type="button" onClick={slip.undoClear} className={LINK}>
                    Undo
                  </button>
                </p>
              )}
              {slip.leagueRemoved && (
                <p className="text-xs font-medium text-muted-foreground">
                  {slip.leagueRemoved} ·{" "}
                  <button type="button" onClick={slip.undoLeagueRemoval} className={LINK}>
                    Undo
                  </button>
                </p>
              )}
              {pool.length > 0 && (
                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className={LABEL}>Your picks · {pool.length}</p>
                  </div>
                  <div className="mt-2 grid gap-2.5 md:grid-cols-2">
                    {byGame.map((picks) => (
                      <div key={picks[0].gameId} className="rounded-[14px] border border-[#E6E8EF] bg-white dark:border-border dark:bg-card">
                        <p className={LABEL + " border-b border-[#0F1420]/[0.06] px-3.5 py-2 dark:border-white/10"}>
                          {picks[0].leagueName} · {picks[0].gameLabel} · {formatGameTime(picks[0].gameTime)}
                        </p>
                        <ul className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
                          {picks.map((p) => {
                            const r = records ? bestAvailableRecord(p, records) : null;
                            return (
                              <li key={p.pickId} className="flex items-center gap-2.5 py-1 pl-3.5 pr-1">
                                <div className="min-w-0 flex-1 py-1">
                                  <p className="text-sm font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{p.betDetail}</p>
                                  <p className="text-xs font-medium text-muted-foreground">
                                    <Link href={"/cappers/" + p.capperId} className="text-foreground hover:underline">
                                      {p.capperName}
                                    </Link>
                                    {records && " · " + (r ? `${r.wins}–${r.losses}` : "no record yet")}
                                  </p>
                                  <StartedLine game={p} />
                                  {droppedNote.has(p.pickId) && <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{droppedNote.get(p.pickId)}</p>}
                                </div>
                                <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">{formatOdds(p.odds)}</span>
                                <RemoveButton label={`Remove ${p.capperName} pick from your slip`} onClick={() => slip.removeFromPool(p.pickId)} />
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs font-medium text-muted-foreground">
                    {fillFrom === "BEST_AVAILABLE"
                      ? "Best available doesn't use these — they stay here for Combined and Your picks only."
                      : combined
                        ? "Regenerate rotates through these. Remove one with ×."
                        : "The parlay is drawn from these. Remove one with ×."}
                  </p>
                </div>
              )}
              {removed && (
                <div className="text-xs font-medium text-muted-foreground">
                  <p className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">{removedHeading(removed)}</span>
                    <button type="button" onClick={slip.dismissRemoved} className={LINK}>
                      Dismiss
                    </button>
                  </p>
                  <ul className="mt-0.5 list-disc pl-4">
                    {removed.picks.map((p) => (
                      <li key={p.pickId}>{removedPickText(p)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {targets.length > 0 && (
                <div>
                  <p className={LABEL}>Target games · {targetedGames.length}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {targetedGames.map((g) =>
                      g.viaPicks ? (
                        <span key={g.gameId} className={CHIP + " border-[#DADDE5] bg-muted text-foreground dark:border-border"} title="In play through your picks - remove the picks to drop it">
                          {g.gameLabel}
                          <span className="font-medium text-muted-foreground">· your picks</span>
                        </span>
                      ) : (
                        <span key={g.gameId} className={CHIP + " border-brand-600 bg-brand-600 pr-1 text-white"}>
                          {g.gameLabel}
                          <button type="button" onClick={() => slip.toggleTarget(g)} aria-label={"Stop targeting " + g.gameLabel} className="flex h-7 w-7 items-center justify-center rounded-full text-base leading-none hover:bg-white/20">
                            ×
                          </button>
                        </span>
                      )
                    )}
                    <button type="button" onClick={slip.clearTargets} className={CHIP + " border-[#DADDE5] bg-white text-foreground hover:bg-foreground/[0.035] dark:border-border dark:bg-card"}>
                      Use full slate
                    </button>
                  </div>
                  <p className="mt-2 text-xs font-medium text-muted-foreground">
                    The generator picks the best available legs from targeted games. Games from your picks are always included.
                  </p>
                </div>
              )}
            </div>
          )}
        </Section>

        {/* 2 · Pick filters */}
        <Section
          n={2}
          title="Pick Filters"
          description={
            !favoritesOnly ? (
              "Choose which games to build around, or use the full slate."
            ) : hasFavorites ? (
              FAVORITES_SUBTITLE
            ) : (
              <>
                {NO_FAVORITES_SUBTITLE}{" "}
                <Link href="/cappers" className={LINK}>
                  Go to Cappers
                </Link>
              </>
            )
          }
        >
          <div className="space-y-3">
            <FilterRow label="Leagues">
              {leagues.map((league) => (
                <ScopeChip
                  key={league}
                  label={league}
                  inScope={isLeagueInScope(league)}
                  onToggle={() => toggleLeague(league)}
                  ariaLabel={
                    isLeagueLocked(league)
                      ? "Leave out " + league + " games - removes your " + league + " picks from the slip"
                      : (isLeagueInScope(league) ? "Leave out " : "Include ") + league + " games"
                  }
                />
              ))}
            </FilterRow>
            {/* relative: the Pick Mix popover opens under this row, at its width. */}
            <FilterRow label="Bet types" className="relative">
              {/* Your picks only ignores Bet Types and Pick Mix (slip picks are never filtered): shown, not usable. */}
              <div aria-disabled={yourPicksOnly || undefined} className={"flex flex-wrap items-center gap-2" + (yourPicksOnly ? " pointer-events-none opacity-45" : "")} inert={yourPicksOnly || undefined}>
                <IncludePicksChips value={include} onToggle={onToggleInclude} />
                {categories.length > 1 && <PickMixControl categories={categories} mix={mix} legCount={legCount} onChange={setMix} />}
              </div>
              {yourPicksOnly && <span className="text-xs font-medium text-muted-foreground">Applies to Best available</span>}
            </FilterRow>
            <FilterRow label="Live">
              <PillSwitch label={INCLUDE_LIVE_LABEL} on={includeLive} onToggle={toggleIncludeLive} />
            </FilterRow>
            <FilterRow label="Favorites">
              <button
                type="button"
                onClick={toggleFavoritesOnly}
                aria-pressed={favoritesOnly}
                aria-label={FAVORITES_STAR_LABEL}
                title={FAVORITES_STAR_LABEL}
                className={
                  "inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition " +
                  (favoritesOnly
                    ? "border-[#f5c451] bg-[#fff7e0] text-[#b45309] dark:bg-amber-500/15 dark:text-amber-400"
                    : "pill-inactive hover:text-[#b45309]")
                }
              >
                <StarIcon filled={favoritesOnly} className="h-4 w-4" />
                Favorite Cappers Only
              </button>
            </FilterRow>
            <SettingsBlock>
              <SettingRow
                icon={<LayersIcon className="h-5 w-5" />}
                label="Total legs"
                note={
                  combined
                    ? combinedLegsNote(manualSlots, legCount - manualSlots, favoritesOnly)
                    : legsNote({ yourPicksOnly, legCount, usable: built ? built.capacity : pool.length, total: built ? built.slipTotal : pool.length, favoritesOnly })
                }
              >
                <LegStepper value={legCount} max={maxLegs} min={minLegs} onChange={(n) => setLegCount(Math.max(minLegs, Math.min(n, maxLegs)))} />
              </SettingRow>
              <SettingRow
                icon={<GamepadIcon className="h-5 w-5" />}
                label="Max legs per game"
                note={maxPerGame === 1 ? "One leg per game, your picks included." : "Same-game legs only when games run out · never opposing or duplicate."}
              >
                <StepperControl label="Max legs per game" value={maxPerGame} min={1} max={MAX_LEGS_PER_GAME} onChange={(n) => setMaxPerGame(Math.max(1, Math.min(MAX_LEGS_PER_GAME, n)))} />
              </SettingRow>
              <SettingRow
                icon={<TrophyIcon className="h-5 w-5" />}
                label="Minimum capper win rate"
              >
                <StepperControl label="Minimum capper win rate" value={minWinPct} min={GATE_MIN} max={GATE_MAX} step={GATE_STEP} unit="%" onChange={setMinWinPct} />
              </SettingRow>
              {/* One row with its mix box: no rule between them. */}
              <div>
                <SettingRow
                  icon={<DatabaseIcon className="h-5 w-5" />}
                  label="Fill from"
                  note={pool.length > MAX_PARLAY_LEGS && fillFrom !== "BEST_AVAILABLE" ? POOL_OVER_CAP_NOTE : (fillFromHelp(fillFrom, pool.length) ?? undefined)}
                >
                  <TextSegments
                    label="Fill from"
                    options={FILL_FROM_OPTIONS}
                    value={fillFrom}
                    disabled={disabledFillFrom(pool.length)}
                    disabledTitle={pool.length === 0 ? NEEDS_PICKS_TITLE : undefined}
                    onChange={(v) => setFillFrom(effectiveFillFrom(pool.length, v))}
                  />
                </SettingRow>
                {combined && (
                  // Left-aligned with the Fill from buttons (the row's 200px label column + its 16px gap).
                  <div className="pb-3.5 sm:pl-[216px]">
                    <CombinedMixBox
                      manual={manualSlots}
                      total={legCount}
                      max={maxManualSlots(legCount, pool.length)}
                      slipSize={pool.length}
                      onChange={(n) => patchGeneratorFilters({ manualSplit: { manual: clampManualSlots(n, legCount, pool.length), total: legCount } })}
                    />
                  </div>
                )}
              </div>
            </SettingsBlock>
          </div>
        </Section>

        {/* Clear · Generate */}
        <div className="mt-3.5 flex flex-wrap items-center justify-end gap-3 border-t border-[#0F1420]/[0.08] pt-3.5 dark:border-white/10">
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={clear} disabled={!parlay && !error && !build.reveal} className={PILL_OUTLINE}>
              Clear result
            </button>
            {parlay && builtFor === key && (
              <button type="button" onClick={() => void run("refresh")} disabled={busy || inputs.leagues.length === 0} className={PILL_OUTLINE} title="Reload the picks, odds and records, then rebuild">
                Refresh
              </button>
            )}
            <button type="button" onClick={() => void run("generate", true, true)} disabled={busy || inputs.leagues.length === 0} className={PILL_PRIMARY}>
              <BoltIcon className="h-4 w-4" />
              {busy ? "Generating…" : "Generate parlay"}
            </button>
          </div>
        </div>
        {parlay && builtFor === key && parlay.capacity < MAX_PARLAY_LEGS && legCount >= parlay.capacity && (
          <p className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-400">{parlay.capacityText}</p>
        )}
        {inputs.leagues.length === 0 && <p className="mt-2 text-xs font-medium text-muted-foreground">Switch at least one league on to generate a parlay.</p>}
        {error && <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}
      </PanelShell>

      {(build.reveal || (parlay && builtFor === key)) && (
        <GeneratorResult
          // Keyed on the build, never on the leg count or the legs shown so far: one card
          // from analyzing to complete. A build in progress is keyed on its sequence (its
          // generatedKey isn't known until the answer, and two Generates can share one).
          key={build.reveal ? "build-" + build.reveal.id : parlay!.generatedKey}
          parlay={parlay && builtFor === key ? parlay : null}
          reveal={build.reveal}
          requestedLegs={legCount}
          favoritesOnly={favoritesOnly}
          busy={busy}
          noAlternative={noAlternative}
          unavailableTargetLabels={(parlay?.unavailableTargets ?? []).map((id) => targetLabel.get(id) ?? "A targeted game")}
          liveTargetLabels={(parlay?.liveTargets ?? []).map((id) => targetLabel.get(id) ?? "A targeted game")}
          onRegenerate={() => void run("regenerate", true)}
          changedPickIds={changedPickIds}
          selectionMode={selectionMode}
          onSelectionMode={setSelectionMode}
          onSent={() => {
            // Your picks stay; only Live's slip mode ends.
            slip.exitSlipMode();
          }}
          // Swap one leg by hand: on the session's snapshot, never a request.
          legSwap={{
            options: (i) => (parlay ? session.current.swapOptions(parlay, i, settings) : { PRIMARY: [], HEDGE: [], CONTRARIAN: [], OTHER_GAMES: [] }),
            apply: (i, pickId) => {
              const next = parlay && session.current.swapLeg(parlay, i, pickId, settings);
              if (!next) return false;
              setParlay(next);
              return true;
            },
          }}
          // Every swapped leg back: the parlay as built (no request, no rebuild).
          onResetAll={() => {
            if (!asBuilt) return;
            setChangedPickIds(null);
            setParlay(asBuilt);
            // Combined's rotation follows the parlay put back (generator-session.ts).
            session.current.adopt(asBuilt);
          }}
        />
      )}
      {!build.reveal && parlay && builtFor === key && parlay.legs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {favoritesOnly ? FAVORITES_EMPTY : <>No qualified picks {targets.length > 0 ? "in the targeted games" : "in your selected leagues right now"}.</>}
        </p>
      )}
    </>
  );
}
