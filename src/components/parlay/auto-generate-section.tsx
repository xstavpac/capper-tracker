"use client";

// Auto-Generate: builds Parlay A from today's unstarted games (one leg per
// game - each game's best pick from the user's own cappers, ranked by the
// same market record My Picks ranks by), and shows its Hedge and Contrarian
// variants as tabs beside it. All selection happens server-side in
// autoGenerateParlayAction; this component only holds the controls and
// renders the result. Its scope/leg-count state is local - it never touches
// the Parlay Pool or My Picks' scope.
import { useEffect, useState } from "react";
import { autoGenerateParlayAction, type AutoGenerateResult } from "@/server/actions/parlay-generator";
import { CONTROL, FOOTER_LINK, FOOTER_TEXT, PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { BoltIcon, ListChecksIcon } from "@/components/dashboard/cappers-icons";
import { LABEL, LegStepper, PILL_OUTLINE, PILL_PRIMARY, ScopeChip, Tabs } from "@/components/parlay/parlay-controls";
import { LEG_LIST, LegRow, ResultBlock, SwapBlock, formatOdds, rankedRecordText } from "@/components/parlay/swap-result";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import type { AutoLeg, SwapMode } from "@/lib/parlay/auto-generate";

const DEFAULT_IN_SCOPE_LEAGUE = "MLB";

const ICON = "h-[17px] w-[17px] stroke-[2.2]";
const AUTO = {
  ...TINTS.neutral,
  title: "Auto-Generate",
  subtitle: "One leg per game from today's unstarted games, using only your tracked cappers' picks.",
  icon: <BoltIcon className={ICON} />,
};
const RESULT_SUBTITLE = "Each game's top pick from your cappers, ranked by their record in that market";

// What the last generate found, for the page's stat tiles: how many of
// today's unstarted games have a pick, and in which leagues it looked.
export type GeneratedSummary = { gamesWithPicks: number; leagues: string[] };

type ResultTab = "PRIMARY" | SwapMode;

function ParlayALeg({ n, leg }: { n: number; leg: AutoLeg }) {
  return (
    <LegRow n={n} pick={leg.top.pick} recordText={rankedRecordText(leg.top)} winPct={leg.top.record?.winPct ?? null}>
      {leg.next.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11.5px] font-semibold text-brand-600 dark:text-brand-400">
            Next {leg.next.length} pick{leg.next.length === 1 ? "" : "s"} in this game
          </summary>
          <ul className="mt-1.5 space-y-1.5">
            {leg.next.map((r) => (
              <li key={r.pick.pickId} className="rounded-[10px] border border-[#E6E8EF] bg-white px-3 py-2 dark:border-border dark:bg-card">
                <div className="flex items-baseline justify-between gap-3 text-[13px] font-semibold text-foreground">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{r.pick.betDetail}</span>
                  <span className="shrink-0 tabular-nums">{formatOdds(r.pick.odds)}</span>
                </div>
                <p className="text-[11.5px] font-medium text-muted-foreground">
                  {r.pick.capperName} · {rankedRecordText(r)}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </LegRow>
  );
}

export function AutoGenerateSection({ leagues, onGenerated }: { leagues: string[]; onGenerated?: (summary: GeneratedSummary | null) => void }) {
  const [scope, setScope] = useState<Record<string, boolean>>({});
  const [legCount, setLegCountState] = useState(3);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AutoGenerateResult | null>(null);
  // Fewer games than requested is never silently built smaller - the user
  // confirms the K-leg parlay first (same rule as My Picks' ShortfallNotice).
  const [shortfallConfirmed, setShortfallConfirmed] = useState(false);
  const [tab, setTab] = useState<ResultTab>("PRIMARY");

  const isInScope = (league: string) => scope[league] ?? league === DEFAULT_IN_SCOPE_LEAGUE;
  const inScopeLeagues = leagues.filter(isInScope);
  const scopeKey = inScopeLeagues.join(",");

  // A result built for a different scope/leg count no longer describes the
  // current selection - clear it rather than leave it on screen.
  useEffect(() => {
    setResult(null);
    setShortfallConfirmed(false);
    setTab("PRIMARY");
  }, [scopeKey, legCount]);

  useEffect(() => {
    onGenerated?.(result ? { gamesWithPicks: result.parlayA.available, leagues: result.leaguesSearched } : null);
  }, [result, onGenerated]);

  async function generate() {
    setBuilding(true);
    setError(null);
    try {
      const next = await autoGenerateParlayAction(inScopeLeagues, legCount);
      if ("error" in next) {
        setError(next.error);
        return;
      }
      setResult(next);
      setShortfallConfirmed(false);
      setTab("PRIMARY");
    } catch {
      setError("Couldn't generate a parlay right now - try again.");
    } finally {
      setBuilding(false);
    }
  }

  function clear() {
    setResult(null);
    setError(null);
    setShortfallConfirmed(false);
    setTab("PRIMARY");
  }

  const parlayA = result?.parlayA ?? null;
  const isShort = parlayA !== null && parlayA.available < parlayA.requested;
  const showParlays = parlayA !== null && parlayA.legs.length > 0 && (!isShort || shortfallConfirmed);
  const resultLeagues = parlayA ? Array.from(new Set(parlayA.legs.map((l) => l.top.pick.leagueName))) : [];

  return (
    <>
      <PanelShell theme={AUTO} footer={undefined} wrapSubtitle>
        <p className={LABEL}>League scope</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {leagues.map((league) => (
            <ScopeChip
              key={league}
              label={league}
              inScope={isInScope(league)}
              onToggle={() => setScope((prev) => ({ ...prev, [league]: !isInScope(league) }))}
              ariaLabel={(isInScope(league) ? "Remove " : "Include ") + league + " games from Auto-Generate"}
            />
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <LegStepper
            value={legCount}
            max={MAX_PARLAY_LEGS}
            onChange={(n) => setLegCountState(Math.max(1, Math.min(n, MAX_PARLAY_LEGS)))}
            note={`one per game · up to ${MAX_PARLAY_LEGS}`}
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={clear} disabled={!result} className={PILL_OUTLINE}>
              Clear
            </button>
            <button type="button" onClick={generate} disabled={inScopeLeagues.length === 0 || building} className={PILL_PRIMARY}>
              <BoltIcon className="h-4 w-4" />
              {building ? "Generating…" : "Generate parlay"}
            </button>
          </div>
        </div>
        {inScopeLeagues.length === 0 && (
          <p className="mt-2 text-xs font-medium text-muted-foreground">Toggle at least one league on to generate a parlay.</p>
        )}
        {error && <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}

        {parlayA && parlayA.available === 0 && (
          <p className="mt-4 text-sm text-muted-foreground">
            No games left today with picks from your cappers in {result!.leaguesSearched.join(", ")}.
          </p>
        )}

        {parlayA && isShort && parlayA.available > 0 && !shortfallConfirmed && (
          <div className="mt-4 rounded-[14px] border border-amber-300 bg-amber-50/60 p-3.5 dark:border-amber-800 dark:bg-amber-500/10">
            <h3 className="text-sm font-semibold text-foreground">
              Only {parlayA.available} game{parlayA.available === 1 ? "" : "s"} available
            </h3>
            <p className="mt-1 text-xs font-medium text-muted-foreground">
              You asked for {parlayA.requested} legs, but only {parlayA.available} of today&apos;s unstarted games have
              picks from your cappers. Each game can give one leg.
            </p>
            <button type="button" onClick={() => setShortfallConfirmed(true)} className={PILL_PRIMARY + " mt-3"}>
              Build with {parlayA.available} leg{parlayA.available === 1 ? "" : "s"}
            </button>
          </div>
        )}
      </PanelShell>

      {showParlays && result && (
        <PanelShell
          theme={{
            ...TINTS.neutral,
            title: "Generated parlay",
            subtitle: "Parlay A and its Hedge and Contrarian variants",
            icon: <ListChecksIcon className={ICON} />,
          }}
          control={
            <span className={CONTROL + " shrink-0 px-2.5 py-1 " + TINTS.neutral.control}>
              {parlayA!.legs.length} leg{parlayA!.legs.length === 1 ? "" : "s"} · {resultLeagues.join(", ")}
            </span>
          }
          footer={
            <>
              <p className={FOOTER_TEXT}>
                {parlayA!.available} game{parlayA!.available === 1 ? "" : "s"} with picks in {result.leaguesSearched.join(", ")}
              </p>
              <button type="button" onClick={generate} disabled={building} className={FOOTER_LINK + " px-1 py-2.5 disabled:opacity-50 " + TINTS.neutral.accent}>
                {building ? "Regenerating…" : "Regenerate"}
              </button>
            </>
          }
          busy={building}
          wrapSubtitle
        >
          <Tabs<ResultTab>
            label="Parlay variant"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "PRIMARY", label: "Primary" },
              { key: "AUTO_HEDGE", label: "Hedge", note: result.hedge.swapCount + "/" + result.hedge.legs.length },
              { key: "CONTRARIAN", label: "Contrarian", note: result.contrarian.swapCount + "/" + result.contrarian.legs.length },
            ]}
          />
          <div className="mt-3">
            {tab === "PRIMARY" && (
              <ResultBlock title={`Parlay A — ${parlayA!.legs.length}-leg parlay`} subtitle={RESULT_SUBTITLE} plain>
                <ol className={LEG_LIST}>
                  {parlayA!.legs.map((leg, i) => (
                    <ParlayALeg key={leg.gameId} n={i + 1} leg={leg} />
                  ))}
                </ol>
              </ResultBlock>
            )}
            {tab === "AUTO_HEDGE" && <SwapBlock parlay={result.hedge} plain />}
            {tab === "CONTRARIAN" && <SwapBlock parlay={result.contrarian} plain />}
          </div>
        </PanelShell>
      )}
    </>
  );
}
