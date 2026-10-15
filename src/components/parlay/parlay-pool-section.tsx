"use client";

// My Picks: the Parlay Generator's slip. Lists the slip - its picks and its
// games ("best pick from this game"), any of them locked - grouped by game
// with a per-league scope chip, a leg-count stepper (bounded by the in-scope
// slip, or by MAX_PARLAY_LEGS when the qualified pool may fill in - see
// lib/parlay/leg-cap.ts), a Source toggle and the builds. "Build from slip"
// is My Picks' build (lib/parlay/slip-build.ts, run server-side by
// buildSlipParlayAction): locked items first, then the best of the rest by
// the same record ranking, conflict-checked; Slip only never adds a pick
// from outside the slip.
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { gameItemKey, useParlayPool, type SlipGame } from "@/components/parlay/parlay-pool-context";
import { Message, PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { ClipboardIcon } from "@/components/dashboard/cappers-icons";
import { LABEL, LegStepper, PILL_OUTLINE, PILL_PRIMARY, ScopeChip, SEGMENT_GROUP, SEGMENT_OFF, SEGMENT_ON, TextSegments } from "@/components/parlay/parlay-controls";
import {
  ExcludedFromSlip,
  LEG_LIST,
  LegRow,
  ResultBlock,
  SwapBlock,
  formatGameTime,
  formatOdds,
  rankedRecordText,
  rankedWhy,
  skippedAsExcluded,
} from "@/components/parlay/swap-result";
import { bestAvailableRecord, formatRecord } from "@/lib/parlay/pick-record";
import type { SkippedPick, UnverifiedPair } from "@/lib/parlay/build-my-picks";
import type { SwapMode } from "@/lib/parlay/auto-generate";
import { SLIP_SOURCE_OPTIONS, slipShortfallText } from "@/lib/parlay/slip-build";
import {
  buildSlipParlayAction,
  generatePoolSwapAction,
  type PoolSwapResult,
  type SlipBuildResult,
  type SlipRequestItem,
} from "@/server/actions/parlay-pool-generator";
import { SendToFanDuel } from "@/components/parlay/send-to-fanduel";
import { slipSendLegs } from "@/lib/parlay/slip-send-legs";

const MY_PICKS = {
  ...TINTS.neutral,
  title: "My Picks",
  subtitle: "Build a parlay from your slip - lock what must be in it.",
  icon: <ClipboardIcon className="h-[17px] w-[17px] stroke-[2.2]" />,
};

// The lock on a slip item: a locked pick is always in the built parlay; a
// locked game always gives it a leg.
function LockButton({ itemKey, name }: { itemKey: string; name: string }) {
  const { isLocked, toggleLock } = useParlayPool();
  const locked = isLocked(itemKey);
  return (
    <button
      type="button"
      onClick={() => toggleLock(itemKey)}
      aria-pressed={locked}
      aria-label={(locked ? "Unlock " : "Lock ") + name}
      title={locked ? "Locked - always in the built parlay" : "Lock - always include in the built parlay"}
      className={
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition " +
        (locked ? "text-brand-600 dark:text-brand-400" : "text-muted-foreground hover:bg-foreground/[0.035] hover:text-foreground")
      }
    >
      <svg viewBox="0 0 24 24" fill={locked ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d={locked ? "M8 11V7a4 4 0 0 1 8 0v4" : "M8 11V7a4 4 0 0 1 7.5-1.9"} fill="none" />
      </svg>
    </button>
  );
}

function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-foreground/[0.035] hover:text-foreground"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}

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
  const { legCount, setLegCount, maxLegCount, maxBuildLegs, source } = useParlayPool();
  return (
    <LegStepper
      value={legCount}
      max={maxBuildLegs}
      onChange={setLegCount}
      note={
        source === "SLIP_PLUS_POOL" && maxLegCount > 0
          ? `${maxLegCount} from your slip · the rest from your cappers`
          : `of ${maxLegCount} in-scope pick${maxLegCount === 1 ? "" : "s"}`
      }
    />
  );
}

type BuiltParlay = SlipBuildResult;

// Skipped/uncertainty notes are always rendered as plain visible text, never
// behind a hover-only affordance - the trust story here is the same one the
// white paper's Section 9 explanation layer describes for swaps: a skip is
// exactly as visible as the leg it produced.
// Skips are listed as "Excluded from your slip", each with its own reason.
function BuildNotes({ skipped, unverified, started = [] }: { skipped: SkippedPick[]; unverified: UnverifiedPair[]; started?: SlipBuildResult["startedGames"] }) {
  const excluded = [...skippedAsExcluded(skipped), ...started.map((g) => ({ key: "game:" + g.gameId, label: g.gameLabel, reason: "Game started" }))];
  if (excluded.length === 0 && unverified.length === 0) return null;
  return (
    <>
      <ExcludedFromSlip items={excluded} />
      {unverified.length > 0 && (
        <div className="space-y-1 border-t border-[#0F1420]/[0.08] py-2.5 dark:border-white/10">
          {unverified.map((u) => (
            <p key={`${u.pickId}-${u.withPickId}`} className="text-xs font-medium text-amber-700 dark:text-amber-400">
              {u.note}
            </p>
          ))}
        </div>
      )}
    </>
  );
}

// Each leg says where it came from: a locked slip item, the slip, or (with
// "Slip + qualified picks") the rest of your cappers' picks, untagged.
function BuildMyPicksResult({ result }: { result: BuiltParlay }) {
  const locked = new Set(result.lockedPickIds);
  const fromSlip = new Set(result.slipPickIds);
  return (
    <ResultBlock title={`My Picks — ${result.legs.length}-leg parlay`} priceLegs={result.legs} sendLegs={result.legs}>
      <ol className={LEG_LIST}>
        {result.legs.map((leg, i) => {
          const record = bestAvailableRecord(leg, result.records);
          const tag = locked.has(leg.pickId) ? "Locked" : fromSlip.has(leg.pickId) && result.source === "SLIP_PLUS_POOL" ? "Slip" : undefined;
          return (
            <LegRow
              key={leg.pickId}
              n={i + 1}
              pick={leg}
              recordText={rankedRecordText({ record, pick: leg })}
              winPct={record?.winPct ?? null}
              tag={tag}
              why={rankedWhy({ record, pick: leg }, { locked: locked.has(leg.pickId) })}
            />
          );
        })}
      </ol>
      <BuildNotes skipped={result.skipped} unverified={result.unverified} started={result.startedGames} />
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
type ShortfallLike = { legs: unknown[]; skipped: SkippedPick[]; unverified: UnverifiedPair[]; requested: number; startedGames?: SlipBuildResult["startedGames"] };
function ShortfallNotice({ result, onBuildAnyway, message }: { result: ShortfallLike; onBuildAnyway: () => void; message?: string }) {
  return (
    <div className="mt-4 rounded-[14px] border border-amber-300 bg-amber-50/60 p-3.5 dark:border-amber-800 dark:bg-amber-500/10">
      <h3 className="mb-2 text-sm font-semibold text-foreground">
        Only {result.legs.length} of {result.requested} legs available without conflicts
      </h3>
      {message && <p className="mb-2 text-xs font-medium text-muted-foreground">{message}</p>}
      <BuildNotes skipped={result.skipped} unverified={result.unverified} started={result.startedGames} />
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
  return <SwapBlock parlay={result.swap} excluded={skippedAsExcluded(result.skipped)} />;
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
  const { pool, games: slipGames, leaguesInPool, isLeagueInScope, removeFromPool, removeGame, isLocked, legCount, maxLegCount, source, setSource } =
    useParlayPool();
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
  // Everything else a build depends on: the slip's games, its locks and the Source.
  const slipKey =
    slipGames.map((g) => g.gameId).join(",") +
    "|" +
    [...pool.map((p) => p.pickId), ...slipGames.map((g) => gameItemKey(g.gameId))].filter(isLocked).join(",") +
    "|" +
    source;

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

  // A stale build result (from before the slip/scope/leg count changed) is
  // worse than no result - clear it rather than leave a parlay on screen
  // that no longer reflects the current selection. maxLegCount changes
  // whenever a league scope toggle changes the in-scope item count, so it
  // stands in for scope here without threading the raw scope map through.
  useEffect(() => {
    setBuildResult(null);
    setBuildError(null);
    setShortfallConfirmed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poolKey/slipKey stand in for slip membership
  }, [poolKey, slipKey, legCount, maxLegCount]);

  async function buildFromSlip() {
    const picks = pool.filter((p) => isLeagueInScope(p.leagueName));
    const games = slipGames.filter((g) => isLeagueInScope(g.leagueName));
    if (picks.length + games.length === 0) return;
    setBuilding(true);
    setBuildError(null);
    try {
      // Ids only: the server reads each pick and game itself (parlay-pool-generator.ts).
      const items: SlipRequestItem[] = [
        ...picks.map((p) => ({ kind: "PICK" as const, pickId: p.pickId, locked: isLocked(p.pickId) })),
        ...games.map((g) => ({ kind: "GAME" as const, gameId: g.gameId, leagueName: g.leagueName, locked: isLocked(gameItemKey(g.gameId)) })),
      ];
      const next = await buildSlipParlayAction(items, legCount, source, leaguesInPool.filter(isLeagueInScope));
      if ("error" in next) {
        setBuildResult(null);
        setBuildError(next.error);
        return;
      }
      setBuildResult(next);
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

  if (pool.length === 0 && slipGames.length === 0) {
    return (
      <PanelShell theme={MY_PICKS} control={action} footer={undefined} wrapSubtitle>
        <Message>
          Your Parlay slip is empty. Use the Parlay slip button in the banner above, or on Live, to add picks - or &quot;+ Add game&quot; on a
          generated parlay to add a whole game.
        </Message>
        <SendToFanDuel legs={[]} keepWhenEmpty />
      </PanelShell>
    );
  }

  // The slip's games, in the order their first pick (or the game itself) was added.
  const gameIds = Array.from(new Set([...pool.map((p) => p.gameId), ...slipGames.map((g) => g.gameId)]));
  const games = gameIds.map((gameId) => {
    const picks = pool.filter((p) => p.gameId === gameId);
    const item = slipGames.find((g) => g.gameId === gameId) ?? null;
    const head: SlipGame = item ?? { gameId, gameLabel: picks[0].gameLabel, gameTime: picks[0].gameTime, leagueName: picks[0].leagueName };
    return { head, item, picks };
  });

  return (
    <PanelShell theme={MY_PICKS} control={action} footer={undefined} wrapSubtitle>
      {recordsError && (
        <p className="mb-2.5 text-xs font-medium text-red-600 dark:text-red-400">Couldn&apos;t load your cappers&apos; records for these picks.</p>
      )}
      <p className={LABEL}>League scope</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {leaguesInPool.map((league) => (
          <LeagueChip
            key={league}
            league={league}
            count={pool.filter((p) => p.leagueName === league).length + slipGames.filter((g) => g.leagueName === league).length}
          />
        ))}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {games.map(({ head, item, picks }) => {
          const inScope = isLeagueInScope(head.leagueName);
          return (
            <div
              key={head.gameId}
              className={"rounded-[14px] border border-[#E6E8EF] bg-white dark:border-border dark:bg-card " + (inScope ? "" : "opacity-60")}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-[#0F1420]/[0.06] px-3.5 py-2.5 dark:border-white/10">
                <p className="min-w-0 text-sm font-semibold text-foreground">{head.gameLabel}</p>
                <p className={LABEL}>
                  {head.leagueName} · {formatGameTime(head.gameTime)}
                  {!inScope && " · excluded"}
                </p>
              </div>
              <ul className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
                {item && (
                  <li className="flex items-center gap-2.5 py-1 pl-3.5 pr-1">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-brand-600 dark:border-brand-400" aria-hidden="true" />
                    <div className="min-w-0 flex-1 py-1">
                      <p className="text-sm font-semibold leading-snug text-foreground">Best pick from this game</p>
                      <p className="text-xs font-medium text-muted-foreground">Chosen from your cappers&apos; picks when you build</p>
                    </div>
                    <LockButton itemKey={gameItemKey(head.gameId)} name={head.gameLabel + " (best pick from this game)"} />
                    <RemoveButton onClick={() => removeGame(head.gameId)} label={"Remove " + head.gameLabel + " from Parlay slip"} />
                  </li>
                )}
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
                      <LockButton itemKey={p.pickId} name={p.capperName + " pick"} />
                      <RemoveButton onClick={() => removeFromPool(p.pickId)} label={"Remove " + p.capperName + " pick from Parlay slip"} />
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      {/* The whole slip as it stands, every league - scope only shapes the builds below. */}
      <div className="mt-3">
        <SendToFanDuel legs={slipSendLegs(pool)} keepWhenEmpty />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={LABEL}>Source</span>
        <TextSegments label="Build from" options={SLIP_SOURCE_OPTIONS} value={source} onChange={setSource} />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <LegCountStepper />
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div role="group" aria-label="Build a parlay" className={"grid flex-1 grid-cols-3 gap-1 " + SEGMENT_GROUP}>
            <BuildSegment
              label="Build from slip"
              sub={source === "SLIP_ONLY" ? "slip only" : "slip + qualified"}
              busy={building}
              active={buildResult !== null}
              disabled={maxLegCount === 0 || building}
              onClick={buildFromSlip}
            />
            <BuildSegment
              label="Auto Hedge"
              sub="primary + hedge"
              busy={hedge.building}
              active={hedge.result !== null}
              disabled={pool.length === 0 || maxLegCount === 0 || hedge.building}
              onClick={hedge.build}
            />
            <BuildSegment
              label="Contrarian"
              sub="when available"
              busy={contrarian.building}
              active={contrarian.result !== null}
              disabled={pool.length === 0 || maxLegCount === 0 || contrarian.building}
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
        <ShortfallNotice result={buildResult} message={slipShortfallText(buildResult)} onBuildAnyway={() => setShortfallConfirmed(true)} />
      )}
      {buildResult && buildResult.legs.length > 0 && (buildResult.shortfall === 0 || shortfallConfirmed) && <BuildMyPicksResult result={buildResult} />}
      <SwapModeResult mode="AUTO_HEDGE" swap={hedge} />
      <SwapModeResult mode="CONTRARIAN" swap={contrarian} />
    </PanelShell>
  );
}
