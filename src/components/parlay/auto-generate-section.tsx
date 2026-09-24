"use client";

// Auto-Generate: builds Parlay A from today's unstarted games (one leg per
// game - each game's best pick from the user's own cappers, ranked by the
// same market record My Picks ranks by), and on request shows its Hedge and
// Contrarian variants next to it. All selection happens server-side in
// autoGenerateParlayAction; this component only holds the controls and
// renders the result. Its scope/leg-count state is local - it never touches
// the Parlay Pool or My Picks' scope.
import { useEffect, useState } from "react";
import { autoGenerateParlayAction, type AutoGenerateResult } from "@/server/actions/parlay-generator";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { PickCard } from "@/components/live/pick-card";
import { ScopeToggle, LegStepper } from "@/components/parlay/parlay-controls";
import { GameHeader, ResultColumn, SwapColumn, marketNoun } from "@/components/parlay/swap-result";
import { rankBasisLabel } from "@/lib/parlay/pick-record";
import { AUTO_GENERATE_MAX_LEGS } from "@/lib/parlay/auto-generate-config";
import type { AutoLeg, RankedPick } from "@/lib/parlay/auto-generate";

const DEFAULT_IN_SCOPE_LEAGUE = "MLB";

// The exact record a leg was ranked on, always shown - including a thin
// sample, and including when the capper has no history at all. The basis
// suffix (rankBasisLabel) is what keeps this readable next to a Hedge/
// Contrarian swap's record, which is always all-leagues-only - without it
// the two look directly comparable when they aren't (see pick-record.ts).
function RankBasis({ ranked }: { ranked: RankedPick }) {
  const { record, pick } = ranked;
  const text = record
    ? rankBasisLabel(record, { leagueName: pick.leagueName, marketNoun: marketNoun(pick.category) })
    : "No record yet - ranked last";
  return (
    <p className="pl-1 text-[11px] text-muted-foreground">
      Ranked on <span className="font-medium text-foreground">{text}</span>
    </p>
  );
}

function ParlayALeg({ leg, records }: { leg: AutoLeg; records: CapperLeagueRecords }) {
  return (
    <div className="space-y-1">
      <GameHeader label={leg.gameLabel} time={leg.gameTime} />
      <PickCard pick={leg.top.pick} records={records} loading={false} />
      <RankBasis ranked={leg.top} />
      {leg.next.length > 0 && (
        <details className="pl-1">
          <summary className="cursor-pointer text-[11px] font-medium text-brand-600 dark:text-brand-400">
            Next {leg.next.length} pick{leg.next.length === 1 ? "" : "s"} in this game
          </summary>
          <div className="mt-1.5 space-y-1.5">
            {leg.next.map((r) => (
              <div key={r.pick.pickId} className="space-y-0.5">
                <PickCard pick={r.pick} records={records} loading={false} />
                <RankBasis ranked={r} />
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function AutoGenerateSection({ leagues }: { leagues: string[] }) {
  const [scope, setScope] = useState<Record<string, boolean>>({});
  const [legCount, setLegCountState] = useState(3);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AutoGenerateResult | null>(null);
  // Fewer games than requested is never silently built smaller - the user
  // confirms the K-leg parlay first (same rule as My Picks' ShortfallNotice).
  const [shortfallConfirmed, setShortfallConfirmed] = useState(false);
  const [showHedge, setShowHedge] = useState(false);
  const [showContrarian, setShowContrarian] = useState(false);

  const isInScope = (league: string) => scope[league] ?? league === DEFAULT_IN_SCOPE_LEAGUE;
  const inScopeLeagues = leagues.filter(isInScope);
  const scopeKey = inScopeLeagues.join(",");

  // A result built for a different scope/leg count no longer describes the
  // current selection - clear it rather than leave it on screen.
  useEffect(() => {
    setResult(null);
    setShortfallConfirmed(false);
    setShowHedge(false);
    setShowContrarian(false);
  }, [scopeKey, legCount]);

  async function generate() {
    setBuilding(true);
    setError(null);
    try {
      const next = await autoGenerateParlayAction(inScopeLeagues, legCount);
      setResult(next);
      setShortfallConfirmed(false);
      setShowHedge(false);
      setShowContrarian(false);
    } catch {
      setError("Couldn't generate a parlay right now - try again.");
    } finally {
      setBuilding(false);
    }
  }

  const parlayA = result?.parlayA ?? null;
  const isShort = parlayA !== null && parlayA.available < parlayA.requested;
  const showParlays = parlayA !== null && parlayA.legs.length > 0 && (!isShort || shortfallConfirmed);

  return (
    <div className="rounded-card bg-card p-4 shadow-soft">
      <div className="flex flex-wrap gap-2">
        {leagues.map((league) => (
          <div key={league} className="flex items-center gap-2 rounded-full border border-border-subtle py-0.5 pl-3 pr-0.5">
            <span className="text-xs font-semibold text-foreground">{league}</span>
            <ScopeToggle
              inScope={isInScope(league)}
              onToggle={() => setScope((prev) => ({ ...prev, [league]: !isInScope(league) }))}
              ariaLabel={(isInScope(league) ? "Remove " : "Include ") + league + " games from Auto-Generate"}
            />
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <LegStepper
          value={legCount}
          max={AUTO_GENERATE_MAX_LEGS}
          onChange={(n) => setLegCountState(Math.max(1, Math.min(n, AUTO_GENERATE_MAX_LEGS)))}
          note={`one per game · up to ${AUTO_GENERATE_MAX_LEGS}`}
        />
        <button
          type="button"
          onClick={generate}
          disabled={inScopeLeagues.length === 0 || building}
          className="rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
        >
          {building ? "Generating…" : "Auto-Generate"}
        </button>
      </div>
      {inScopeLeagues.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">Toggle at least one league on to generate a parlay.</p>
      )}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {parlayA && parlayA.available === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          No games left today with picks from your cappers in {result!.leaguesSearched.join(", ")}.
        </p>
      )}

      {parlayA && isShort && parlayA.available > 0 && !shortfallConfirmed && (
        <div className="mt-4 rounded-card border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-800 dark:bg-amber-500/10">
          <h3 className="text-sm font-semibold text-foreground">
            Only {parlayA.available} game{parlayA.available === 1 ? "" : "s"} available
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            You asked for {parlayA.requested} legs, but only {parlayA.available} of today&apos;s unstarted games have
            picks from your cappers. Each game can give one leg.
          </p>
          <button
            type="button"
            onClick={() => setShortfallConfirmed(true)}
            className="mt-3 rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white shadow-soft hover:bg-brand-700"
          >
            Build with {parlayA.available} leg{parlayA.available === 1 ? "" : "s"}
          </button>
        </div>
      )}

      {showParlays && result && (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowHedge((v) => !v)}
              aria-pressed={showHedge}
              className={
                "rounded-full px-4 py-1.5 text-sm font-medium shadow-soft " +
                (showHedge ? "bg-brand-600 text-white" : "bg-muted text-foreground hover:bg-muted/70")
              }
            >
              {showHedge ? "Hide Hedge" : "Hedge"}
            </button>
            <button
              type="button"
              onClick={() => setShowContrarian((v) => !v)}
              aria-pressed={showContrarian}
              className={
                "rounded-full px-4 py-1.5 text-sm font-medium shadow-soft " +
                (showContrarian ? "bg-brand-600 text-white" : "bg-muted text-foreground hover:bg-muted/70")
              }
            >
              {showContrarian ? "Hide Contrarian" : "Contrarian"}
            </button>
          </div>
          <div
            className={
              "mt-4 grid gap-4 " +
              (showHedge && showContrarian ? "lg:grid-cols-3" : showHedge || showContrarian ? "md:grid-cols-2" : "")
            }
          >
            <ResultColumn
              title={`Parlay A — ${parlayA!.legs.length}-leg parlay`}
              subtitle="Each game's top pick from your cappers, ranked by their record in that market"
            >
              {parlayA!.legs.map((leg) => (
                <ParlayALeg key={leg.gameId} leg={leg} records={result.records} />
              ))}
            </ResultColumn>
            {showHedge && <SwapColumn parlay={result.hedge} records={result.records} />}
            {showContrarian && <SwapColumn parlay={result.contrarian} records={result.records} />}
          </div>
        </>
      )}
    </div>
  );
}
