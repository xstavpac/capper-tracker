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
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { generateParlayAction } from "@/server/actions/parlay-generate";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { BoltIcon, DatabaseIcon, GamepadIcon, LayersIcon, TrophyIcon } from "@/components/dashboard/cappers-icons";
import { useParlayPool, type PooledPick } from "@/components/parlay/parlay-pool-context";
import { FilterRow, LABEL, LegStepper, PILL_OUTLINE, PILL_PRIMARY, ScopeChip, Section, SettingRow, SettingsBlock, StepperControl, TextSegments } from "@/components/parlay/parlay-controls";
import { IncludePicksChips, PickMixControl } from "@/components/parlay/pick-mix-control";
import { HybridControls, HybridResults, ModeToggle, type Mode } from "@/components/parlay/hybrid-mode";
import { useHybridGenerator } from "@/components/parlay/use-hybrid-generator";
import { formatGameTime, formatOdds, GeneratorResult } from "@/components/parlay/generator-result";
import { reconcileMix, selectedCategories, toggleInclude, type IncludeSelection, type PickMix } from "@/lib/parlay/include-picks";
import type { BetCategory } from "@/lib/parlay/bet-category";
import { MAX_LEGS_PER_GAME, MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import { GATE_DEFAULT, GATE_MAX, GATE_MIN, GATE_STEP, normalizeMinWinPct, readStoredGate, writeStoredGate } from "@/lib/parlay/gate";
import { bestAvailableRecord } from "@/lib/parlay/pick-record";
import { readStoredSwapScope, SWAP_SCOPE_DEFAULT, writeStoredSwapScope, type SwapScope } from "@/lib/parlay/swap-scope";
import { slipLegFloor } from "@/lib/parlay/leg-cap";
import { legRange, legsNote, type NoAlternativeReason } from "@/lib/parlay/subset-ui";
import { createGeneratorSession, poolKey, type PoolInputs } from "@/lib/parlay/generator-session";
import { removedHeading, removedPickText } from "@/lib/parlay/slip-state";
import type { FillFrom, GeneratedParlay, GeneratorSettings } from "@/lib/parlay/generator";

const FILL_FROM_OPTIONS: { key: FillFrom; label: string }[] = [
  { key: "BEST_AVAILABLE", label: "Best available" },
  { key: "YOUR_PICKS_ONLY", label: "Your picks only" },
];
const LINK = "text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400";
const CHIP = "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold";
// The "+ Add ... from Live" links: a filled brand pill, so the way into Live stands out from the quiet text links.
const ADD_FROM_LIVE =
  "inline-flex h-8 items-center rounded-full border border-brand-600 bg-brand-600 px-3.5 text-[13px] font-semibold text-white transition hover:bg-brand-700";

// What the page's stat tiles read from the last build.
export type GeneratorSummary = { legs: number; fromSlip: number; generated: number } | null;

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg leading-none text-muted-foreground transition hover:bg-muted hover:text-foreground">
      ×
    </button>
  );
}

export function GeneratorCard({ leagues, onSummary }: { leagues: string[]; onSummary?: (s: GeneratorSummary) => void }) {
  const slip = useParlayPool();
  const { pool, targets, targetedGames, removed, isLeagueInScope, isLeagueLocked, toggleLeague, legCount, setLegCount, userId } = slip;

  // Standard (this card, as ever) or Hybrid (use-hybrid-generator.ts). Each keeps its own state.
  const [mode, setMode] = useState<Mode>("standard");
  const hybridScope = useMemo(
    () => ({ leagues: leagues.filter(isLeagueInScope), targets: targets.map((t) => ({ gameId: t.gameId, leagueName: t.leagueName })) }),
    [leagues, isLeagueInScope, targets]
  );
  const hybrid = useHybridGenerator(hybridScope);

  const [include, setInclude] = useState<IncludeSelection>("ALL");
  // Rows for the selected categories only; follows the selection (reconcileMix).
  const [mix, setMix] = useState<PickMix | null>(null);
  const categories = selectedCategories(include);
  function onToggleInclude(key: "ALL" | BetCategory) {
    const next = toggleInclude(include, key);
    setInclude(next);
    setMix((m) => m && reconcileMix(m, selectedCategories(next)));
  }
  const [maxPerGame, setMaxPerGame] = useState(1);
  const [fillFromChoice, setFillFrom] = useState<FillFrom>("BEST_AVAILABLE");
  const fillFrom: FillFrom = pool.length === 0 ? "BEST_AVAILABLE" : fillFromChoice;

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
  // Which legs Hedge and Contrarian swap - remembered the same way. Every scope
  // comes with each build, so changing it never rebuilds the parlay.
  const [swapScope, setSwapScopeState] = useState<SwapScope>(SWAP_SCOPE_DEFAULT);
  useEffect(() => {
    setSwapScopeState(readStoredSwapScope(userId));
  }, [userId]);
  function setSwapScope(next: SwapScope) {
    setSwapScopeState(next);
    writeStoredSwapScope(userId, next);
  }

  const [parlay, setParlay] = useState<GeneratedParlay | null>(null);
  const [builtFor, setBuiltFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set by a Regenerate that couldn't vary: why (subset-ui.ts). The parlay shown stays.
  const [noAlternative, setNoAlternative] = useState<NoAlternativeReason | null>(null);
  const session = useRef(createGeneratorSession({ generate: (req) => generateParlayAction(req) }));

  const inputs: PoolInputs = useMemo(
    () => ({ leagues: leagues.filter(isLeagueInScope), slipPickIds: pool.map((p) => p.pickId), targets: targets.map((t) => ({ gameId: t.gameId, leagueName: t.leagueName })) }),
    [leagues, isLeagueInScope, pool, targets]
  );
  const settings: GeneratorSettings = useMemo(
    () => ({ legCount, maxLegsPerGame: maxPerGame, include, mix, fillFrom, minWinPct }),
    [legCount, maxPerGame, include, mix, fillFrom, minWinPct]
  );
  const key = poolKey(inputs);

  // The records Your Picks shows beside each pick - the same call the old
  // slip list made, once per change of picks.
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

  async function run(kind: "generate" | "regenerate" | "refresh") {
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
          ? await session.current.refresh(inputs, settings)
          : kind === "generate"
            ? await session.current.generate(inputs, settings)
            : await session.current.regenerate(inputs, settings);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      if (kind === "regenerate" && res.parlay.variety === "NO_ALTERNATIVE") {
        setNoAlternative(res.parlay.noAlternativeReason ?? "NO_COMPARABLE");
        return;
      }
      setNoAlternative(null);
      setParlay(res.parlay);
      setBuiltFor(key);
    } catch {
      setError("Couldn't generate a parlay right now - try again.");
    } finally {
      setBusy(false);
    }
  }

  // A different pool: the result no longer describes it. The same pool with
  // other settings: the best parlay for them, rebuilt here (no request).
  const settingsKey = JSON.stringify(settings);
  useEffect(() => {
    if (!parlay) return;
    if (builtFor !== key) {
      setParlay(null);
      setNoAlternative(null);
      return;
    }
    void run("generate");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reruns on the pool or the settings changing, nothing else
  }, [key, settingsKey]);

  useEffect(() => {
    onSummary?.(parlay ? { legs: parlay.legs.length, fromSlip: parlay.fromSlip, generated: parlay.generated } : null);
  }, [parlay, onSummary]);

  function clear() {
    setParlay(null);
    setBuiltFor(null);
    setError(null);
    setNoAlternative(null);
  }

  // The leg count. Best available: never fewer than the picks (every one goes in). Your picks only:
  // from 1 - the parlay is that many of them. Either way, once a build has said what the pool holds,
  // never more than it can supply.
  const yourPicksOnly = fillFrom === "YOUR_PICKS_ONLY";
  const built = parlay && builtFor === key ? parlay : null;
  const slipFloor = slipLegFloor(pool, maxPerGame);
  const capacity = built ? built.capacity : MAX_PARLAY_LEGS;
  const { min: minLegs, max: maxLegs } = legRange({ yourPicksOnly, slipFloor, capacity });
  useEffect(() => {
    if (!yourPicksOnly && legCount < minLegs) setLegCount(minLegs);
  }, [yourPicksOnly, legCount, minLegs, setLegCount]);
  const generatedLegs = Math.max(0, legCount - slipFloor);

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

  const hasPicksBody = slip.clearedCount > 0 || pool.length > 0 || Boolean(removed) || targets.length > 0;

  return (
    <>
      <PanelShell
        theme={{
          ...TINTS.neutral,
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
          description="Picks you've locked in for this parlay."
          actions={
            <>
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
              {pool.length > 0 && (
                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className={LABEL}>Your picks · {pool.length}</p>
                    <button type="button" onClick={slip.clearSlip} className={LINK}>
                      Clear all picks
                    </button>
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
                  <p className="mt-2 text-xs font-medium text-muted-foreground">Every pick here goes in the parlay. Remove one with ×.</p>
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
        <Section n={2} title="Pick Filters" description="Choose which games to build around, or use the full slate.">
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
                      ? league + " is on: your slip has picks or games from it"
                      : (isLeagueInScope(league) ? "Leave out " : "Include ") + league + " games"
                  }
                />
              ))}
            </FilterRow>
            {/* relative: the Pick Mix popover opens under this row, at its width. */}
            <FilterRow label="Bet types" className="relative">
              <IncludePicksChips value={include} onToggle={onToggleInclude} />
              {categories.length > 1 && <PickMixControl categories={categories} mix={mix} legCount={legCount} onChange={setMix} />}
            </FilterRow>
            <SettingsBlock>
              <SettingRow
                icon={<LayersIcon className="h-5 w-5" />}
                label="Total legs"
                note={legsNote({ yourPicksOnly, legCount, slipFloor, generatedLegs, usable: built ? built.capacity : pool.length, total: built ? built.slipTotal : pool.length })}
              >
                <LegStepper value={legCount} max={maxLegs} onChange={(n) => setLegCount(Math.max(minLegs, Math.min(n, maxLegs)))} />
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
                note={
                  "Only cappers at or above this win rate on that bet type are used. Lower lets more in; higher is stricter." +
                  (minWinPct < GATE_DEFAULT ? " Under " + GATE_DEFAULT + "% means more risk." : "")
                }
              >
                <StepperControl label="Minimum capper win rate" value={minWinPct} min={GATE_MIN} max={GATE_MAX} step={GATE_STEP} unit="%" onChange={setMinWinPct} />
              </SettingRow>
              <SettingRow
                icon={<DatabaseIcon className="h-5 w-5" />}
                label="Fill from"
                note={pool.length === 0 ? "Add picks to build from your picks only" : undefined}
              >
                <TextSegments label="Fill from" options={FILL_FROM_OPTIONS} value={fillFrom} onChange={(v) => setFillFrom(pool.length === 0 ? "BEST_AVAILABLE" : v)} />
              </SettingRow>
            </SettingsBlock>
          </div>
        </Section>

        {/* Clear · Generate */}
        <div className="mt-3.5 flex flex-wrap items-center justify-end gap-3 border-t border-[#0F1420]/[0.08] pt-3.5 dark:border-white/10">
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={clear} disabled={!parlay && !error} className={PILL_OUTLINE}>
              Clear result
            </button>
            {parlay && builtFor === key && (
              <button type="button" onClick={() => void run("refresh")} disabled={busy || inputs.leagues.length === 0} className={PILL_OUTLINE} title="Reload the picks, odds and records, then rebuild">
                Refresh
              </button>
            )}
            <button type="button" onClick={() => void run("generate")} disabled={busy || inputs.leagues.length === 0} className={PILL_PRIMARY}>
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

      {parlay && builtFor === key && (
        <GeneratorResult
          key={parlay.generatedKey + "|" + parlay.legs.length}
          parlay={parlay}
          busy={busy}
          noAlternative={noAlternative}
          unavailableTargetLabels={parlay.unavailableTargets.map((id) => targetLabel.get(id) ?? "A targeted game")}
          swapScope={swapScope}
          onSwapScope={setSwapScope}
          onRegenerate={() => void run("regenerate")}
          onSent={() => {
            // Your picks stay; only Live's slip mode ends.
            slip.exitSlipMode();
          }}
        />
      )}
      {parlay && builtFor === key && parlay.legs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No qualified picks {targets.length > 0 ? "in the targeted games" : "in your selected leagues right now"}.
        </p>
      )}
    </>
  );
}
