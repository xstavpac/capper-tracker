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
import {
  selectConflictFreeLegs,
  type BuildCandidate,
  type SkippedPick,
  type UnverifiedPair,
} from "@/lib/parlay/build-my-picks";

// Ranks a pooled pick by the same win% already shown on its own card
// (PickCard/getLeagueRecordsAction) - the capper's record for this bet
// category in this league, falling back to their all-time record, then
// their last-20-picks record, in the same "best available" order the card
// itself falls back through. No new scoring model: this is the number
// already on screen for every pick in the pool.
function bestAvailableWinPct(pick: PooledPick, records: CapperLeagueRecords): number {
  const key = pick.capperId + "|" + pick.leagueName + "|" + pick.category;
  const card = pick.category ? records.records[key] : null;
  if (card && card.league.count > 0) return card.league.winPct;
  if (card && card.overall.count > 0) return card.overall.winPct;
  const last20 = records.last20[pick.capperId];
  if (last20 && last20.count > 0) return last20.winPct;
  return -1;
}

function LeagueToggle({ league }: { league: string }) {
  const { isLeagueInScope, toggleLeague } = useParlayPool();
  const inScope = isLeagueInScope(league);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={inScope}
      aria-label={(inScope ? "Remove " : "Include ") + league + " picks from the leg-count build"}
      onClick={() => toggleLeague(league)}
      className="flex items-center gap-2 rounded-full bg-muted/60 py-1 pl-1 pr-2.5"
    >
      <span
        className={
          "relative h-5 w-9 shrink-0 rounded-full transition " + (inScope ? "bg-brand-600" : "bg-muted-foreground/30")
        }
      >
        <span
          className={
            "absolute top-0.5 h-4 w-4 rounded-full bg-card shadow-soft transition " +
            (inScope ? "left-[18px]" : "left-0.5")
          }
        />
      </span>
      <span className="text-xs font-medium text-foreground">{inScope ? "In scope" : "Excluded"}</span>
    </button>
  );
}

function LegCountStepper() {
  const { legCount, setLegCount, maxLegCount } = useParlayPool();
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium text-foreground">Legs</span>
      <div className="flex items-center gap-1 rounded-full border border-border-subtle">
        <button
          type="button"
          onClick={() => setLegCount(legCount - 1)}
          disabled={legCount <= 1}
          aria-label="Fewer legs"
          className="flex h-7 w-7 items-center justify-center text-foreground disabled:opacity-30"
        >
          &minus;
        </button>
        <span className="w-6 text-center text-sm font-semibold text-foreground">{legCount}</span>
        <button
          type="button"
          onClick={() => setLegCount(legCount + 1)}
          disabled={legCount >= maxLegCount}
          aria-label="More legs"
          className="flex h-7 w-7 items-center justify-center text-foreground disabled:opacity-30"
        >
          +
        </button>
      </div>
      <span className="text-xs text-muted-foreground">of {maxLegCount} in-scope pick{maxLegCount === 1 ? "" : "s"}</span>
    </div>
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
// to proceed, not an automatic fallback.
function ShortfallNotice({ result, onBuildAnyway }: { result: BuiltParlay; onBuildAnyway: () => void }) {
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
          <button
            type="button"
            onClick={buildMyPicks}
            disabled={maxLegCount === 0 || building}
            className="rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
          >
            {building ? "Building…" : "Build My Picks"}
          </button>
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
      </div>
    </div>
  );
}
