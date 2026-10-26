"use client";

// The Parlay Generator: one card, one set of controls, one result (PR 6 of the
// consolidation). Top to bottom:
//   1 · Your picks - the slip's picks by game, each always in the parlay.
//   2 · Target games - full slate, or only the games targeted on Live (plus
//       your picks' games).
//   3 · Filters - league scope, Include Picks (All Picks / Moneyline / Spread /
//       Totals / Props) + Pick Mix, max legs per game, Fill from.
//   Legs, Clear, Generate parlay - and the result under it.
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
import { BoltIcon } from "@/components/dashboard/cappers-icons";
import { useParlayPool, type PooledPick } from "@/components/parlay/parlay-pool-context";
import { CountStepper, LABEL, LegStepper, PILL_OUTLINE, PILL_PRIMARY, ScopeChip, TextSegments } from "@/components/parlay/parlay-controls";
import { IncludePicksChips, PickMixControl } from "@/components/parlay/pick-mix-control";
import { formatGameTime, formatOdds, GeneratorResult } from "@/components/parlay/generator-result";
import { reconcileMix, selectedCategories, toggleInclude, type IncludeSelection, type PickMix } from "@/lib/parlay/include-picks";
import type { BetCategory } from "@/lib/parlay/bet-category";
import { MAX_LEGS_PER_GAME, MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import { GATE_DEFAULT, GATE_MAX, GATE_MIN, GATE_STEP, normalizeMinWinPct, readStoredGate, writeStoredGate } from "@/lib/parlay/gate";
import { bestAvailableRecord } from "@/lib/parlay/pick-record";
import { slipLegFloor } from "@/lib/parlay/leg-cap";
import { createGeneratorSession, poolKey, type PoolInputs } from "@/lib/parlay/generator-session";
import { removedHeading, removedPickText } from "@/lib/parlay/slip-state";
import type { FillFrom, GeneratedParlay, GeneratorSettings } from "@/lib/parlay/generator";

const FILL_FROM_OPTIONS: { key: FillFrom; label: string }[] = [
  { key: "BEST_AVAILABLE", label: "Best available" },
  { key: "YOUR_PICKS_ONLY", label: "Your picks only" },
];
const SECTION = "border-t border-[#0F1420]/[0.08] pt-3.5 dark:border-white/10";
const LINK = "text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400";
const CHIP = "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold";

// What the page's stat tiles read from the last build.
export type GeneratorSummary = { legs: number; fromSlip: number; generated: number } | null;

function SectionTitle({ n, title, children }: { n: number; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className={LABEL}>
        {n} · {title}
      </p>
      {children}
    </div>
  );
}

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

  const [parlay, setParlay] = useState<GeneratedParlay | null>(null);
  const [builtFor, setBuiltFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noAlternative, setNoAlternative] = useState(false);
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
        // The slip itself changed (a pick graded, started or gone): the notice
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
        setNoAlternative(true);
        return;
      }
      setNoAlternative(false);
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
      setNoAlternative(false);
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
    setNoAlternative(false);
  }

  // The leg count: never fewer than the picks (every one goes in), and - once
  // a build has said what the pool holds - never more than it can supply.
  const minLegs = Math.min(MAX_PARLAY_LEGS, Math.max(1, slipLegFloor(pool, maxPerGame)));
  const capacity = parlay && builtFor === key ? parlay.capacity : MAX_PARLAY_LEGS;
  const maxLegs = Math.max(minLegs, Math.min(MAX_PARLAY_LEGS, capacity));
  useEffect(() => {
    if (legCount < minLegs) setLegCount(minLegs);
  }, [legCount, minLegs, setLegCount]);
  const generatedLegs = Math.max(0, legCount - slipLegFloor(pool, maxPerGame));

  // Your picks, by game, in the order they were added.
  const byGame = useMemo(() => {
    const groups = new Map<string, PooledPick[]>();
    for (const p of pool) groups.set(p.gameId, [...(groups.get(p.gameId) ?? []), p]);
    return Array.from(groups.values());
  }, [pool]);
  const droppedNote = new Map((parlay && builtFor === key ? parlay.dropped : []).map((d) => [d.pickId, d.note]));
  const targetLabel = new Map(targets.map((t) => [t.gameId, t.gameLabel]));

  return (
    <>
      <PanelShell
        theme={{
          ...TINTS.neutral,
          title: "Parlay Generator",
          subtitle: "Your picks are in every parlay. The rest are the best qualified picks from your cappers.",
          icon: <BoltIcon className="h-[17px] w-[17px] stroke-[2.2]" />,
        }}
        footer={undefined}
        wrapSubtitle
      >
        {/* 1 · Your picks */}
        <SectionTitle n={1} title={`Your picks${pool.length > 0 ? " · " + pool.length : ""}`}>
          <span className="flex items-center gap-3">
            {pool.length > 0 && (
              <button type="button" onClick={slip.clearSlip} className={LINK}>
                Clear all picks
              </button>
            )}
            <Link href="/live" className={LINK}>
              + Add picks from Live
            </Link>
          </span>
        </SectionTitle>
        {slip.clearedCount > 0 && (
          <p className="mt-1.5 text-xs font-medium text-muted-foreground">
            Cleared {slip.clearedCount} pick{slip.clearedCount === 1 ? "" : "s"}.{" "}
            <button type="button" onClick={slip.undoClear} className={LINK}>
              Undo
            </button>
          </p>
        )}
        {pool.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Picks you&apos;ve locked in for this parlay.</p>
        ) : (
          <>
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
          </>
        )}
        {removed && (
          <div className="mt-1.5 text-xs font-medium text-muted-foreground">
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

        {/* 2 · Target games */}
        <div className={"mt-4 " + SECTION}>
          {targets.length === 0 ? (
            <>
              <SectionTitle n={2} title="Target games">
                <Link href="/live" className={LINK}>
                  + Add games from Live
                </Link>
              </SectionTitle>
              <p className="mt-2 text-sm text-muted-foreground">Choose which games to build around, or use the full slate.</p>
            </>
          ) : (
            <>
              <SectionTitle n={2} title={`Target games · ${targetedGames.length}`}>
                <Link href="/live" className={LINK}>
                  + Add games from Live
                </Link>
              </SectionTitle>
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
            </>
          )}
        </div>

        {/* 3 · Filters */}
        <div className={"mt-4 " + SECTION}>
          <SectionTitle n={3} title="Filters" />
          <div className="mt-2 flex flex-wrap gap-2">
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
          </div>
          {/* relative: the Pick Mix popover opens under this row, at its width. */}
          <div className="relative mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className={LABEL}>Include picks</span>
            <IncludePicksChips value={include} onToggle={onToggleInclude} />
            {categories.length > 1 && <PickMixControl categories={categories} mix={mix} legCount={legCount} onChange={setMix} />}
          </div>
          <div className="mt-3.5">
            <CountStepper
              label="Max legs per game"
              value={maxPerGame}
              min={1}
              max={MAX_LEGS_PER_GAME}
              onChange={(n) => setMaxPerGame(Math.max(1, Math.min(MAX_LEGS_PER_GAME, n)))}
              note={maxPerGame === 1 ? "one leg per game, your picks included" : "same-game legs only when games run out · never opposing or duplicate"}
            />
          </div>
          <div className="mt-3.5">
            <CountStepper
              label="Minimum win rate"
              value={minWinPct}
              min={GATE_MIN}
              max={GATE_MAX}
              step={GATE_STEP}
              unit="%"
              onChange={setMinWinPct}
              note={
                "Only cappers at or above this win rate on that bet type are used. Lower lets more in; higher is stricter." +
                (minWinPct < GATE_DEFAULT ? " Under " + GATE_DEFAULT + "% means more risk." : "")
              }
            />
          </div>
          <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className={LABEL}>Fill from</span>
            <TextSegments label="Fill from" options={FILL_FROM_OPTIONS} value={fillFrom} onChange={(v) => setFillFrom(pool.length === 0 ? "BEST_AVAILABLE" : v)} />
            {pool.length === 0 && <span className="text-xs font-medium text-muted-foreground">Add picks to build from your picks only</span>}
          </div>
        </div>

        {/* Legs · Clear · Generate */}
        <div className={"mt-4 flex flex-wrap items-center justify-between gap-3 " + SECTION}>
          <LegStepper
            value={legCount}
            max={maxLegs}
            onChange={(n) => setLegCount(Math.max(minLegs, Math.min(n, maxLegs)))}
            note={`up to ${MAX_PARLAY_LEGS} · ${slipLegFloor(pool, maxPerGame)} from your picks, ${generatedLegs} from your cappers`}
          />
          <div className="flex flex-wrap gap-2">
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
