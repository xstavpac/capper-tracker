"use client";

// My Picks: the Parlay Generator's simplest construction mode. Lists the
// pool grouped by league with a per-league scope toggle, a leg-count
// stepper bounded by how many in-scope picks exist, and a build action that
// selects the best-winPct qualifying combination from exactly the pooled,
// in-scope picks - no substitutions, alternates, or picks from outside the
// pool.
import { useEffect, useState } from "react";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { PickCard } from "@/components/live/pick-card";
import { useParlayPool, type PooledPick } from "@/components/parlay/parlay-pool-context";
import { ScopeToggle, LegStepper } from "@/components/parlay/parlay-controls";
import { SwapColumn } from "@/components/parlay/swap-result";
import { bestAvailableRecord } from "@/lib/parlay/pick-record";
import {
  selectConflictFreeLegs,
  type BuildCandidate,
  type SkippedPick,
  type UnverifiedPair,
} from "@/lib/parlay/build-my-picks";
import type { SwapMode } from "@/lib/parlay/auto-generate";
import { generatePoolSwapAction, type PoolSwapResult } from "@/server/actions/parlay-pool-generator";

// Ranks a pooled pick by the same win% already shown on its own card - see
// bestAvailableRecord (shared with Auto-Generate). No new scoring model:
// this is the number already on screen for every pick in the pool.
function bestAvailableWinPct(pick: PooledPick, records: CapperLeagueRecords): number {
  return bestAvailableRecord(pick, records)?.winPct ?? -1;
}

function LeagueToggle({ league }: { league: string }) {
  const { isLeagueInScope, toggleLeague } = useParlayPool();
  const inScope = isLeagueInScope(league);
  return (
    <ScopeToggle
      inScope={inScope}
      onToggle={() => toggleLeague(league)}
      ariaLabel={(inScope ? "Remove " : "Include ") + league + " picks from the leg-count build"}
    />
  );
}

function LegCountStepper() {
  const { legCount, setLegCount, maxLegCount } = useParlayPool();
  return (
    <LegStepper
      value={legCount}
      max={maxLegCount}
      onChange={setLegCount}
      note={`of ${maxLegCount} in-scope pick${maxLegCount === 1 ? "" : "s"}`}
    />
  );
}

// Turns a pooled pick into the classifier's plain input shape - rawBetDetail
// (not the display-formatted betDetail) plus the game fields describePick/
// classifyPair need. label is what shows up in a skip/uncertainty note, so it
// needs to read on its own without the rest of the pick card around it.
function toBuildCandidate(p: PooledPick): BuildCandidate {
  return {
    pickId: p.pickId,
    label: `${p.capperName} — ${p.betDetail}`,
    betType: p.betType,
    period: p.period,
    betDetail: p.rawBetDetail,
    line: p.line,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    gameTime: new Date(p.gameTime),
    sportName: p.leagueName,
  };
}

type BuiltParlay = {
  legs: PooledPick[];
  skipped: SkippedPick[];
  unverified: UnverifiedPair[];
  requested: number;
  shortfall: number;
};

// Skipped/uncertainty notes are always rendered as plain visible text, never
// behind a hover-only affordance - the trust story here is the same one the
// white paper's Section 9 explanation layer describes for swaps: a skip is
// exactly as visible as the leg it produced.
function BuildNotes({ skipped, unverified }: { skipped: SkippedPick[]; unverified: UnverifiedPair[] }) {
  if (skipped.length === 0 && unverified.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 border-t border-border-subtle pt-3">
      {skipped.map((s) => (
        <p key={s.pickId} className="text-[12px] text-muted-foreground">
          {s.note}
        </p>
      ))}
      {unverified.map((u) => (
        <p key={`${u.pickId}-${u.withPickId}`} className="text-[12px] text-amber-700 dark:text-amber-400">
          {u.note}
        </p>
      ))}
    </div>
  );
}

function BuildMyPicksResult({ result }: { result: BuiltParlay }) {
  return (
    <div className="mt-4 rounded-card border border-brand-200 bg-brand-50/60 p-4 dark:border-brand-800 dark:bg-brand-500/10">
      <h3 className="mb-2 text-sm font-semibold text-foreground">
        My Picks &mdash; {result.legs.length}-leg parlay
      </h3>
      <div className="space-y-1.5">
        {result.legs.map((leg) => (
          <div key={leg.pickId} className="rounded-[7px] border border-border-subtle bg-card px-2.5 py-2 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">{leg.capperName}</span>
              <span className="text-muted-foreground">
                {leg.odds > 0 ? "+" : ""}
                {leg.odds}
              </span>
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {leg.gameLabel} &middot; {leg.betDetail}
            </div>
          </div>
        ))}
      </div>
      <BuildNotes skipped={result.skipped} unverified={result.unverified} />
    </div>
  );
}

// Shown instead of BuildMyPicksResult when fewer conflict-free legs exist
// than requested - never silently builds the smaller parlay. The skip notes
// explain WHY it's short; "Build with K legs" is the user's explicit choice
// to proceed, not an automatic fallback. `legs` is typed loosely (only
// .length is read) so both My Picks' own BuiltParlay and a pool-driven
// Hedge/Contrarian result's primary (PoolSwapResult.parlayA.legs, a
// different shape) can share this one notice.
type ShortfallLike = { legs: unknown[]; skipped: SkippedPick[]; unverified: UnverifiedPair[]; requested: number };
function ShortfallNotice({ result, onBuildAnyway }: { result: ShortfallLike; onBuildAnyway: () => void }) {
  return (
    <div className="mt-4 rounded-card border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-800 dark:bg-amber-500/10">
      <h3 className="text-sm font-semibold text-foreground">
        Only {result.legs.length} of {result.requested} legs available without conflicts
      </h3>
      <BuildNotes skipped={result.skipped} unverified={result.unverified} />
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onBuildAnyway}
          className="rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white shadow-soft hover:bg-brand-700"
        >
          Build with {result.legs.length} leg{result.legs.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}

const SWAP_MODE_LABEL: Record<SwapMode, string> = { AUTO_HEDGE: "Auto Hedge", CONTRARIAN: "Contrarian" };

// Auto Hedge / Contrarian over the pool: reuses the exact primary
// construction My Picks uses server-side (buildPoolPrimary in
// lib/parlay/pool-swap.ts - same ranking, same selectConflictFreeLegs
// conflict validation) and then searches each of those legs' own game for a
// qualifying alternate via buildSwapParlay - the same engine Auto-Generate
// uses (lib/parlay/auto-generate.ts). One state slice per mode so pressing
// "Auto Hedge" doesn't clobber an already-built "Contrarian" result.
function useSwapBuild(mode: SwapMode) {
  const { pool, isLeagueInScope, legCount } = useParlayPool();
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<PoolSwapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shortfallConfirmed, setShortfallConfirmed] = useState(false);

  const inScopeKey = pool
    .filter((p) => isLeagueInScope(p.leagueName))
    .map((p) => p.pickId)
    .join(",");

  // A stale result (built before the in-scope pool or leg count changed) is
  // worse than no result - same rule as My Picks' own staleness effect.
  useEffect(() => {
    setResult(null);
    setError(null);
    setShortfallConfirmed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inScopeKey stands in for in-scope pool membership
  }, [inScopeKey, legCount]);

  async function build() {
    const inScope = pool.filter((p) => isLeagueInScope(p.leagueName));
    if (inScope.length === 0) return;
    setBuilding(true);
    setError(null);
    try {
      const next = await generatePoolSwapAction(inScope, legCount, mode);
      setResult(next);
      setShortfallConfirmed(false);
    } catch {
      setError("Couldn't build this parlay right now - try again.");
    } finally {
      setBuilding(false);
    }
  }

  function clear() {
    setResult(null);
    setError(null);
    setShortfallConfirmed(false);
  }

  return { building, result, error, shortfallConfirmed, setShortfallConfirmed, build, clear };
}

function SwapModeResult({ mode, swap }: { mode: SwapMode; swap: ReturnType<typeof useSwapBuild> }) {
  const { result, error, shortfallConfirmed, setShortfallConfirmed } = swap;
  if (error) return <p className="mt-4 text-xs text-red-600 dark:text-red-400">{error}</p>;
  if (!result) return null;
  const isShort = result.shortfall > 0;
  if (result.parlayA.legs.length === 0) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        No conflict-free {SWAP_MODE_LABEL[mode]} picks available from your in-scope pool.
      </p>
    );
  }
  if (isShort && !shortfallConfirmed) {
    return (
      <ShortfallNotice
        result={{ legs: result.parlayA.legs, skipped: result.skipped, unverified: result.unverified, requested: result.requested }}
        onBuildAnyway={() => setShortfallConfirmed(true)}
      />
    );
  }
  return (
    <div className="mt-4">
      <SwapColumn parlay={result.swap} records={result.records} />
    </div>
  );
}

export function ParlayPoolSection() {
  const { pool, leaguesInPool, isLeagueInScope, removeFromPool, legCount, maxLegCount } = useParlayPool();
  const [records, setRecords] = useState<CapperLeagueRecords | null>(null);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<BuiltParlay | null>(null);
  // Section 9: a shortfall (fewer conflict-free legs than requested) is never
  // silently built - the user must explicitly confirm building the smaller
  // parlay via ShortfallNotice's "Build with K legs" action before it renders
  // as a built parlay.
  const [shortfallConfirmed, setShortfallConfirmed] = useState(false);
  const hedge = useSwapBuild("AUTO_HEDGE");
  const contrarian = useSwapBuild("CONTRARIAN");

  const poolKey = pool.map((p) => p.pickId).join(",");

  useEffect(() => {
    let cancelled = false;
    if (pool.length === 0) {
      setRecords(null);
      return;
    }
    setLoadingRecords(true);
    const entries = pool.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }));
    getLeagueRecordsAction(entries).then((result) => {
      if (cancelled) return;
      setRecords(result);
      setLoadingRecords(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poolKey stands in for pool (array identity changes every render otherwise)
  }, [poolKey]);

  // A stale build result (from before the pool/scope/leg count changed) is
  // worse than no result - clear it rather than leave a parlay on screen
  // that no longer reflects the current selection. maxLegCount changes
  // whenever a league scope toggle changes the in-scope pick count, so it
  // stands in for scope here without threading the raw scope map through.
  useEffect(() => {
    setBuildResult(null);
    setShortfallConfirmed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poolKey stands in for pool membership
  }, [poolKey, legCount, maxLegCount]);

  async function buildMyPicks() {
    const inScope = pool.filter((p) => isLeagueInScope(p.leagueName));
    if (inScope.length === 0) return;
    setBuilding(true);
    const entries = inScope.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }));
    const freshRecords = await getLeagueRecordsAction(entries);
    // The ranking itself is untouched by conflict validation - only which
    // ranked picks get selected changes (Section 9). byId maps the
    // classifier's minimal candidates back to their full pooled pick for
    // rendering (odds, gameLabel, etc.).
    const ranked = [...inScope].sort((a, b) => bestAvailableWinPct(b, freshRecords) - bestAvailableWinPct(a, freshRecords));
    const byId = new Map(ranked.map((p) => [p.pickId, p]));
    const selection = selectConflictFreeLegs(ranked.map(toBuildCandidate), legCount);
    setBuildResult({
      legs: selection.legs.map((c) => byId.get(c.pickId)!),
      skipped: selection.skipped,
      unverified: selection.unverified,
      requested: selection.requested,
      shortfall: selection.shortfall,
    });
    setShortfallConfirmed(false);
    setBuilding(false);
  }

  function clearBuilt() {
    setBuildResult(null);
    setShortfallConfirmed(false);
    hedge.clear();
    contrarian.clear();
  }

  const hasBuiltResult = buildResult !== null || hedge.result !== null || contrarian.result !== null;

  if (pool.length === 0) {
    return (
      <div className="rounded-card bg-card p-6 text-center shadow-soft">
        <p className="text-sm text-muted-foreground">
          Your Parlay slip is empty. Use the Parlay slip button on Live (or below) to add picks.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {leaguesInPool.map((league) => (
        <div key={league}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">{league}</h3>
            <LeagueToggle league={league} />
          </div>
          <div className="space-y-1.5">
            {pool
              .filter((p) => p.leagueName === league)
              .map((p) => (
                <PickCard
                  key={p.pickId}
                  pick={p}
                  records={records}
                  loading={loadingRecords}
                  onRemove={() => removeFromPool(p.pickId)}
                />
              ))}
          </div>
        </div>
      ))}

      <div className="rounded-card bg-card p-4 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <LegCountStepper />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={buildMyPicks}
              disabled={maxLegCount === 0 || building}
              className="rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
            >
              {building ? "Building…" : "Build My Picks"}
            </button>
            <button
              type="button"
              onClick={hedge.build}
              disabled={maxLegCount === 0 || hedge.building}
              className="rounded-full bg-muted px-4 py-1.5 text-sm font-medium text-foreground shadow-soft hover:bg-muted/70 disabled:opacity-50"
            >
              {hedge.building ? "Building…" : "Auto Hedge"}
            </button>
            <button
              type="button"
              onClick={contrarian.build}
              disabled={maxLegCount === 0 || contrarian.building}
              className="rounded-full bg-muted px-4 py-1.5 text-sm font-medium text-foreground shadow-soft hover:bg-muted/70 disabled:opacity-50"
            >
              {contrarian.building ? "Building…" : "Contrarian"}
            </button>
            <button
              type="button"
              onClick={clearBuilt}
              disabled={!hasBuiltResult}
              className="rounded-full bg-muted px-4 py-1.5 text-sm font-medium text-foreground shadow-soft hover:bg-muted/70 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
        {maxLegCount === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Every pooled league is excluded from scope - toggle at least one on above to build a parlay.
          </p>
        )}
        {buildResult && buildResult.shortfall > 0 && !shortfallConfirmed && (
          <ShortfallNotice result={buildResult} onBuildAnyway={() => setShortfallConfirmed(true)} />
        )}
        {buildResult && (buildResult.shortfall === 0 || shortfallConfirmed) && <BuildMyPicksResult result={buildResult} />}
        <SwapModeResult mode="AUTO_HEDGE" swap={hedge} />
        <SwapModeResult mode="CONTRARIAN" swap={contrarian} />
      </div>
    </div>
  );
}
