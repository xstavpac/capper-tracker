"use client";

// My Picks: the Parlay Generator's simplest construction mode. Lists the
// pool grouped by game with a per-league scope chip, a leg-count
// stepper bounded by how many in-scope picks exist (and by MAX_PARLAY_LEGS,
// see lib/parlay/leg-cap.ts), and a build action that
// selects the best-winPct qualifying combination from exactly the pooled,
// in-scope picks - no substitutions, alternates, or picks from outside the
// pool.
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { useParlayPool, type PooledPick } from "@/components/parlay/parlay-pool-context";
import { Message, PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { ClipboardIcon } from "@/components/dashboard/cappers-icons";
import { LABEL, LegStepper, PILL_OUTLINE, PILL_PRIMARY, ScopeChip, SEGMENT_GROUP, SEGMENT_OFF, SEGMENT_ON } from "@/components/parlay/parlay-controls";
import { LEG_LIST, LegRow, ResultBlock, SwapBlock, formatGameTime, formatOdds, rankedRecordText } from "@/components/parlay/swap-result";
import { bestAvailableRecord, formatRecord, rankPoolPicks } from "@/lib/parlay/pick-record";
import {
  selectConflictFreeLegs,
  type BuildCandidate,
  type SkippedPick,
  type UnverifiedPair,
} from "@/lib/parlay/build-my-picks";
import type { SwapMode } from "@/lib/parlay/auto-generate";
import { generatePoolSwapAction, type PoolSwapResult } from "@/server/actions/parlay-pool-generator";

const MY_PICKS = {
  ...TINTS.neutral,
  title: "My Picks",
  subtitle: "Build a parlay from exactly the picks in your slip.",
  icon: <ClipboardIcon className="h-[17px] w-[17px] stroke-[2.2]" />,
};

function LeagueChip({ league, count }: { league: string; count: number }) {
  const { isLeagueInScope, toggleLeague } = useParlayPool();
  const inScope = isLeagueInScope(league);
  return (
    <ScopeChip
      label={league}
      count={count}
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
    gameId: p.gameId,
  };
}

type BuiltParlay = {
  legs: PooledPick[];
  skipped: SkippedPick[];
  unverified: UnverifiedPair[];
  requested: number;
  shortfall: number;
  // The records the legs were ranked on, for each leg's record line.
  records: CapperLeagueRecords;
};

// Skipped/uncertainty notes are always rendered as plain visible text, never
// behind a hover-only affordance - the trust story here is the same one the
// white paper's Section 9 explanation layer describes for swaps: a skip is
// exactly as visible as the leg it produced.
function BuildNotes({ skipped, unverified }: { skipped: SkippedPick[]; unverified: UnverifiedPair[] }) {
  if (skipped.length === 0 && unverified.length === 0) return null;
  return (
    <div className="space-y-1 border-t border-[#0F1420]/[0.08] py-2.5 dark:border-white/10">
      {skipped.map((s) => (
        <p key={s.pickId} className="text-xs font-medium text-muted-foreground">
          {s.note}
        </p>
      ))}
      {unverified.map((u) => (
        <p key={`${u.pickId}-${u.withPickId}`} className="text-xs font-medium text-amber-700 dark:text-amber-400">
          {u.note}
        </p>
      ))}
    </div>
  );
}

function BuildMyPicksResult({ result }: { result: BuiltParlay }) {
  return (
    <ResultBlock title={`My Picks — ${result.legs.length}-leg parlay`} priceLegs={result.legs}>
      <ol className={LEG_LIST}>
        {result.legs.map((leg, i) => {
          const record = bestAvailableRecord(leg, result.records);
          return <LegRow key={leg.pickId} n={i + 1} pick={leg} recordText={rankedRecordText({ record, pick: leg })} winPct={record?.winPct ?? null} />;
        })}
      </ol>
      <BuildNotes skipped={result.skipped} unverified={result.unverified} />
    </ResultBlock>
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
    <div className="mt-4 rounded-[14px] border border-amber-300 bg-amber-50/60 p-3.5 dark:border-amber-800 dark:bg-amber-500/10">
      <h3 className="mb-2 text-sm font-semibold text-foreground">
        Only {result.legs.length} of {result.requested} legs available without conflicts
      </h3>
      <BuildNotes skipped={result.skipped} unverified={result.unverified} />
      <div className="mt-1 flex items-center gap-2">
        <button type="button" onClick={onBuildAnyway} className={PILL_PRIMARY}>
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
      // Ids only: the server reads each pick itself (parlay-pool-generator.ts).
      const next = await generatePoolSwapAction(
        inScope.map((p) => p.pickId),
        legCount,
        mode
      );
      if ("error" in next) {
        setError(next.error);
        return;
      }
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
  if (error) return <p className="mt-4 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>;
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
  return <SwapBlock parlay={result.swap} />;
}

// One of the three builds, as a segment: its name over what it builds from.
// Lit while its parlay is on screen. Each calls its own builder.
function BuildSegment({
  label,
  sub,
  busy,
  active,
  disabled,
  onClick,
}: {
  label: string;
  sub: string;
  busy: boolean;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={"flex min-h-11 flex-col items-center justify-center rounded-xl px-1.5 py-1 leading-tight transition disabled:opacity-50 sm:px-4 " + (active ? SEGMENT_ON : SEGMENT_OFF)}
    >
      <span className="whitespace-nowrap text-[13px] font-semibold">{busy ? "Building…" : label}</span>
      <span className={"whitespace-nowrap text-[10.5px] font-medium " + (active ? "text-white/80" : "text-muted-foreground")}>{sub}</span>
    </button>
  );
}

// `action` is the header's link (the page's "+ Add picks from Live").
export function ParlayPoolSection({ action }: { action?: ReactNode }) {
  const { pool, leaguesInPool, isLeagueInScope, removeFromPool, legCount, maxLegCount } = useParlayPool();
  const [records, setRecords] = useState<CapperLeagueRecords | null>(null);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [recordsError, setRecordsError] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
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
    setRecordsError(false);
    if (pool.length === 0) {
      setRecords(null);
      return;
    }
    setLoadingRecords(true);
    const entries = pool.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }));
    getLeagueRecordsAction(entries).then(
      (result) => {
        if (cancelled) return;
        setRecords(result);
        setLoadingRecords(false);
      },
      () => {
        // The cards still render, just without their records - never left
        // showing "loading" for a request that is no longer in flight.
        if (cancelled) return;
        setLoadingRecords(false);
        setRecordsError(true);
      }
    );
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
    setBuildError(null);
    setShortfallConfirmed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poolKey stands in for pool membership
  }, [poolKey, legCount, maxLegCount]);

  async function buildMyPicks() {
    const inScope = pool.filter((p) => isLeagueInScope(p.leagueName));
    if (inScope.length === 0) return;
    setBuilding(true);
    setBuildError(null);
    try {
      const entries = inScope.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }));
      const freshRecords = await getLeagueRecordsAction(entries);
      // Ranked by the same record already shown on each pick's own card
      // (rankPoolPicks, shared with the pool's Auto Hedge / Contrarian). The
      // ranking itself is untouched by conflict validation - only which
      // ranked picks get selected changes (Section 9). byId maps the
      // classifier's minimal candidates back to their full pooled pick for
      // rendering (odds, gameLabel, etc.).
      const ranked = rankPoolPicks(inScope, freshRecords);
      const byId = new Map(ranked.map((p) => [p.pickId, p]));
      const selection = selectConflictFreeLegs(ranked.map(toBuildCandidate), legCount);
      setBuildResult({
        legs: selection.legs.map((c) => byId.get(c.pickId)!),
        skipped: selection.skipped,
        unverified: selection.unverified,
        requested: selection.requested,
        shortfall: selection.shortfall,
        records: freshRecords,
      });
      setShortfallConfirmed(false);
    } catch {
      setBuildResult(null);
      setBuildError("Couldn't build this parlay right now - try again.");
    } finally {
      setBuilding(false);
    }
  }

  function clearBuilt() {
    setBuildResult(null);
    setBuildError(null);
    setShortfallConfirmed(false);
    hedge.clear();
    contrarian.clear();
  }

  const hasBuiltResult =
    buildResult !== null || buildError !== null || hedge.result !== null || contrarian.result !== null;

  if (pool.length === 0) {
    return (
      <PanelShell theme={MY_PICKS} control={action} footer={undefined} wrapSubtitle>
        <Message>Your Parlay slip is empty. Use the Parlay slip button in the banner above, or on Live, to add picks.</Message>
      </PanelShell>
    );
  }

  // The slip's games, in the order their first pick was added.
  const games = Array.from(new Set(pool.map((p) => p.gameId))).map((gameId) => pool.filter((p) => p.gameId === gameId));

  return (
    <PanelShell theme={MY_PICKS} control={action} footer={undefined} wrapSubtitle>
      {recordsError && (
        <p className="mb-2.5 text-xs font-medium text-red-600 dark:text-red-400">Couldn&apos;t load your cappers&apos; records for these picks.</p>
      )}
      <p className={LABEL}>League scope</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {leaguesInPool.map((league) => (
          <LeagueChip key={league} league={league} count={pool.filter((p) => p.leagueName === league).length} />
        ))}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {games.map((picks) => {
          const game = picks[0];
          const inScope = isLeagueInScope(game.leagueName);
          return (
            <div
              key={game.gameId}
              className={"rounded-[14px] border border-[#E6E8EF] bg-white dark:border-border dark:bg-card " + (inScope ? "" : "opacity-60")}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-[#0F1420]/[0.06] px-3.5 py-2.5 dark:border-white/10">
                <p className="min-w-0 text-sm font-semibold text-foreground">{game.gameLabel}</p>
                <p className={LABEL}>
                  {game.leagueName} · {formatGameTime(game.gameTime)}
                  {!inScope && " · excluded"}
                </p>
              </div>
              <ul className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
                {picks.map((p) => {
                  const record = records ? bestAvailableRecord(p, records) : null;
                  return (
                    <li key={p.pickId} className="flex items-center gap-2.5 py-1 pl-3.5 pr-1">
                      {/* The team's color (neutral for a total or a team with no color yet). */}
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: p.teamColor ?? "rgb(var(--muted-foreground))" }}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1 py-1">
                        <p className="text-sm font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{p.betDetail}</p>
                        <p className="text-xs font-medium text-muted-foreground">
                          <Link href={"/cappers/" + p.capperId} className="text-foreground hover:underline">
                            {p.capperName}
                          </Link>
                          {loadingRecords ? " · Loading record…" : records ? " · " + (record ? formatRecord(record) : "No record yet") : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">{formatOdds(p.odds)}</span>
                      <button
                        type="button"
                        onClick={() => removeFromPool(p.pickId)}
                        aria-label={"Remove " + p.capperName + " pick from Parlay slip"}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-foreground/[0.035] hover:text-foreground"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <LegCountStepper />
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div role="group" aria-label="Build a parlay" className={"grid flex-1 grid-cols-3 gap-1 " + SEGMENT_GROUP}>
            <BuildSegment
              label="My Picks"
              sub="from your slip"
              busy={building}
              active={buildResult !== null}
              disabled={maxLegCount === 0 || building}
              onClick={buildMyPicks}
            />
            <BuildSegment
              label="Auto Hedge"
              sub="primary + hedge"
              busy={hedge.building}
              active={hedge.result !== null}
              disabled={maxLegCount === 0 || hedge.building}
              onClick={hedge.build}
            />
            <BuildSegment
              label="Contrarian"
              sub="when available"
              busy={contrarian.building}
              active={contrarian.result !== null}
              disabled={maxLegCount === 0 || contrarian.building}
              onClick={contrarian.build}
            />
          </div>
          <button type="button" onClick={clearBuilt} disabled={!hasBuiltResult} className={PILL_OUTLINE}>
            Clear
          </button>
        </div>
      </div>
      {maxLegCount === 0 && (
        <p className="mt-2 text-xs font-medium text-muted-foreground">
          Every pooled league is excluded from scope - toggle at least one on above to build a parlay.
        </p>
      )}
      {buildError && <p className="mt-4 text-xs font-medium text-red-600 dark:text-red-400">{buildError}</p>}
      {buildResult && buildResult.shortfall > 0 && !shortfallConfirmed && (
        <ShortfallNotice result={buildResult} onBuildAnyway={() => setShortfallConfirmed(true)} />
      )}
      {buildResult && (buildResult.shortfall === 0 || shortfallConfirmed) && <BuildMyPicksResult result={buildResult} />}
      <SwapModeResult mode="AUTO_HEDGE" swap={hedge} />
      <SwapModeResult mode="CONTRARIAN" swap={contrarian} />
    </PanelShell>
  );
}
