"use client";

// Auto-Generate: builds Parlay A from today's unstarted games - this week's
// for NFL/NCAAF, see auto-generate-window.ts - (one leg per
// game - each game's best pick from the user's own cappers, ranked by the
// same market record My Picks ranks by), and shows its Hedge and Contrarian
// variants as tabs beside it. All selection happens server-side in
// autoGenerateParlayAction; this component only holds the controls and
// renders the result. Its scope/leg-count state is local - it never touches
// the Parlay Pool or My Picks' scope. Every league starts on.
//
// "Max legs per game" (1 by default) lets a parlay that is short of games take
// a second or third leg from games it already has - see buildSameGameLegs in
// lib/parlay/auto-generate.ts. At 1 nothing here differs from before.
//
// "Include Picks" (All / Game Lines / Props) narrows which picks the parlay is
// built from; with All, an optional Pick Mix (PickMixControl) sets how many
// legs come from game lines vs props. The mix is session state: it lives here,
// survives switching Include Picks away and back, and is gone on reload.
import { useEffect, useState } from "react";
import { autoGenerateParlayAction, type AutoGenerateResult } from "@/server/actions/parlay-generator";
import { CONTROL, FOOTER_LINK, FOOTER_TEXT, PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { BoltIcon, ListChecksIcon } from "@/components/dashboard/cappers-icons";
import { LABEL, LegStepper, NumberSegments, PILL_OUTLINE, PILL_PRIMARY, ScopeChip, Tabs, TextSegments } from "@/components/parlay/parlay-controls";
import { PickMixControl } from "@/components/parlay/pick-mix-control";
import { INCLUDE_PICKS_OPTIONS, mixLabel, mixSplit, type IncludePicks } from "@/lib/parlay/pick-mix";
import { LEG_LIST, LegRow, ResultBlock, SwapBlock, formatOdds, marketNoun, rankedRecordText } from "@/components/parlay/swap-result";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import { autoGenerateWindowText } from "@/lib/parlay/auto-generate-window";
import type { AutoLeg, MaxLegsPerGame, SameGameLeg, SwapMode } from "@/lib/parlay/auto-generate";
import { swapRecordLabel } from "@/lib/parlay/pick-record";
import { legCountText, orderDisplayLegs } from "@/lib/parlay/same-game-display";

const ICON = "h-[17px] w-[17px] stroke-[2.2]";
const AUTO = {
  ...TINTS.neutral,
  title: "Auto-Generate",
  subtitle: "One leg per game from today's unstarted games (this week's for NFL and NCAAF), using only your tracked cappers' picks.",
  icon: <BoltIcon className={ICON} />,
};
const RESULT_SUBTITLE = "Each game's top pick from your cappers, ranked by their record in that market";

// What the last generate found, for the page's stat tiles: how many
// unstarted games in the window have a pick, and in which leagues it looked.
export type GeneratedSummary = { gamesWithPicks: number; leagues: string[] };

type ResultTab = "PRIMARY" | SwapMode;

const SGP_TAG = "SGP";
const MAX_PER_GAME_OPTIONS = [1, 2, 3] as const;
const plural = (n: number) => (n === 1 ? "" : "s");

// What the parlay was built from, for the shortfall card's sentence.
const PICKS_NOUN: Record<IncludePicks, string> = { ALL: "picks", GAME_LINES: "game-line picks", PROPS: "props" };

// The result subtitle's tail for a filtered or mixed build. Empty for plain All.
function builtFromText(include: IncludePicks, gameLinesPct: number | null, requested: number): string {
  if (include === "GAME_LINES") return " · game lines only";
  if (include === "PROPS") return " · props only";
  if (gameLinesPct === null) return "";
  const { gameLines, props } = mixSplit(requested, gameLinesPct);
  return ` · mix ${mixLabel(gameLinesPct)} (${gameLines} game line${plural(gameLines)}, ${props} prop${plural(props)})`;
}

// Plain visible text, same treatment as My Picks' BuildNotes.
function GenerateNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 border-t border-[#0F1420]/[0.08] pt-2.5 dark:border-white/10">
      {notes.map((note) => (
        <p key={note} className="text-xs font-medium text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

// `taken` holds the picks that are legs of this parlay in their own right (the
// same-game legs), so a game's "next picks" never repeats one.
function ParlayALeg({ n, leg, sameGame, taken }: { n: number; leg: AutoLeg; sameGame: boolean; taken: ReadonlySet<string> }) {
  const next = leg.next.filter((r) => !taken.has(r.pick.pickId));
  return (
    <LegRow n={n} pick={leg.top.pick} recordText={rankedRecordText(leg.top)} winPct={leg.top.record?.winPct ?? null} tag={sameGame ? SGP_TAG : undefined}>
      {next.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11.5px] font-semibold text-brand-600 dark:text-brand-400">
            Next {next.length} pick{plural(next.length)} in this game
          </summary>
          <ul className="mt-1.5 space-y-1.5">
            {next.map((r) => (
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

// A leg added from a game Parlay A already has. Its record is the one that
// qualified it - all leagues, its own market - not the record Parlay A ranks by.
function SameGameLegRow({ n, leg }: { n: number; leg: SameGameLeg }) {
  return (
    <LegRow n={n} pick={leg.pick} recordText={swapRecordLabel(leg.record, marketNoun(leg.pick.category))} winPct={leg.record.winPct} tag={SGP_TAG}>
      <p className="mt-1.5 text-[11.5px] font-medium text-muted-foreground">Added from a game already in this parlay</p>
    </LegRow>
  );
}

export function AutoGenerateSection({ leagues, onGenerated }: { leagues: string[]; onGenerated?: (summary: GeneratedSummary | null) => void }) {
  const [scope, setScope] = useState<Record<string, boolean>>({});
  const [legCount, setLegCountState] = useState(3);
  const [maxPerGame, setMaxPerGame] = useState<MaxLegsPerGame>(1);
  const [includePicks, setIncludePicks] = useState<IncludePicks>("ALL");
  // The Pick Mix's Game Lines %, or null for none. Kept while Include Picks is
  // switched away; only sent (and only shown) while it is All.
  const [mixPct, setMixPct] = useState<number | null>(null);
  const appliedMix = includePicks === "ALL" ? mixPct : null;
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AutoGenerateResult | null>(null);
  // Fewer games than requested is never silently built smaller - the user
  // confirms the K-leg parlay first (same rule as My Picks' ShortfallNotice).
  const [shortfallConfirmed, setShortfallConfirmed] = useState(false);
  const [tab, setTab] = useState<ResultTab>("PRIMARY");

  const isInScope = (league: string) => scope[league] ?? true;
  const inScopeLeagues = leagues.filter(isInScope);
  const scopeKey = inScopeLeagues.join(",");

  // A result built for a different scope/leg count no longer describes the
  // current selection - clear it rather than leave it on screen.
  useEffect(() => {
    setResult(null);
    setShortfallConfirmed(false);
    setTab("PRIMARY");
  }, [scopeKey, legCount, maxPerGame, includePicks, appliedMix]);

  useEffect(() => {
    onGenerated?.(result ? { gamesWithPicks: result.parlayA.available, leagues: result.leaguesSearched } : null);
  }, [result, onGenerated]);

  async function generate() {
    setBuilding(true);
    setError(null);
    try {
      const next = await autoGenerateParlayAction(inScopeLeagues, legCount, maxPerGame, includePicks, appliedMix);
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
  // Read leniently: a result with no same-game part is a one-leg-per-game parlay.
  const added = result?.sameGame?.legs ?? [];
  const builtMax = result?.sameGame?.maxLegsPerGame ?? 1;
  const displayLegs = parlayA ? orderDisplayLegs(parlayA.legs, added) : [];
  const legPicks = displayLegs.map((d) => (d.kind === "TOP" ? d.leg.top.pick : d.leg.pick));
  const taken = new Set(added.map((a) => a.pick.pickId));
  // Short of the count asked for, after any same-game legs. Never built
  // smaller without the user saying so.
  const isShort = parlayA !== null && displayLegs.length < parlayA.requested;
  const showParlays = parlayA !== null && parlayA.legs.length > 0 && (!isShort || shortfallConfirmed);
  const resultLeagues = parlayA ? Array.from(new Set(parlayA.legs.map((l) => l.top.pick.leagueName))) : [];
  // Read leniently, like sameGame above: a result without these is a plain All build.
  const builtInclude = result?.includePicks ?? "ALL";
  const builtMix = result?.gameLinesPct ?? null;
  const notes = result?.notes ?? [];
  const swapNote = result?.swapNote ?? null;
  // Nothing to build from: the filter's own empty state ("No props available
  // for WNBA right now.") replaces the generic one when there is one.
  const noneAvailable = parlayA !== null && parlayA.available === 0;

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

        {/* relative: the Pick Mix popover opens under this row, at its width. */}
        <div className="relative mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className={LABEL}>Include picks</span>
          <TextSegments label="Include picks" options={INCLUDE_PICKS_OPTIONS} value={includePicks} onChange={setIncludePicks} />
          {includePicks === "ALL" && <PickMixControl gameLinesPct={mixPct} legCount={legCount} onChange={setMixPct} />}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <LegStepper
            value={legCount}
            max={MAX_PARLAY_LEGS}
            onChange={(n) => setLegCountState(Math.max(1, Math.min(n, MAX_PARLAY_LEGS)))}
            note={`${maxPerGame === 1 ? "one per game" : "up to " + maxPerGame + " per game"} · up to ${MAX_PARLAY_LEGS}`}
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
        <div className="mt-3">
          <NumberSegments
            label="Max legs per game"
            options={MAX_PER_GAME_OPTIONS}
            value={maxPerGame}
            onChange={setMaxPerGame}
            note={
              maxPerGame === 1
                ? "one leg per game"
                : "adds same-game legs only when there aren't enough games to reach your leg count"
            }
          />
        </div>
        {inScopeLeagues.length === 0 && (
          <p className="mt-2 text-xs font-medium text-muted-foreground">Toggle at least one league on to generate a parlay.</p>
        )}
        {error && <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}

        {noneAvailable && notes.length > 0 && (
          <div className="mt-4 space-y-1">
            {notes.map((note) => (
              <p key={note} className="text-sm text-muted-foreground">
                {note}
              </p>
            ))}
          </div>
        )}
        {noneAvailable && notes.length === 0 && (
          <p className="mt-4 text-sm text-muted-foreground">
            No games left {autoGenerateWindowText(result!.leaguesSearched)} with picks from your cappers in{" "}
            {result!.leaguesSearched.join(", ")}.
          </p>
        )}

        {parlayA && isShort && parlayA.available > 0 && !shortfallConfirmed && (
          <div className="mt-4 rounded-[14px] border border-amber-300 bg-amber-50/60 p-3.5 dark:border-amber-800 dark:bg-amber-500/10">
            <h3 className="text-sm font-semibold text-foreground">
              Only {parlayA.available} game{parlayA.available === 1 ? "" : "s"} available
            </h3>
            <p className="mt-1 text-xs font-medium text-muted-foreground">
              You asked for {parlayA.requested} legs, but only {parlayA.available} unstarted game
              {parlayA.available === 1 ? "" : "s"} {autoGenerateWindowText(result!.leaguesSearched)}{" "}
              {parlayA.available === 1 ? "has" : "have"} {PICKS_NOUN[builtInclude]} from your cappers.{" "}
              {builtMax === 1
                ? "Each game can give one leg."
                : added.length > 0
                  ? `${added.length} same-game leg${plural(added.length)} ${added.length === 1 ? "was" : "were"} added (up to ${builtMax} per game), and no other pick on those games both clears 55% in its market and fits with the legs already there.`
                  : `No same-game legs could be added: no other pick on those games both clears 55% in its market and fits with the leg already there.`}
            </p>
            <button type="button" onClick={() => setShortfallConfirmed(true)} className={PILL_PRIMARY + " mt-3"}>
              Build with {displayLegs.length} leg{plural(displayLegs.length)}
            </button>
          </div>
        )}
        {!noneAvailable && <GenerateNotes notes={notes} />}
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
              {legCountText(legPicks, resultLeagues)}
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
              { key: "AUTO_HEDGE", label: "Hedge", note: swapNote ? undefined : result.hedge.swapCount + "/" + result.hedge.legs.length },
              { key: "CONTRARIAN", label: "Contrarian", note: swapNote ? undefined : result.contrarian.swapCount + "/" + result.contrarian.legs.length },
            ]}
          />
          <div className="mt-3">
            {tab === "PRIMARY" && (
              <ResultBlock
                title={`Parlay A — ${displayLegs.length}-leg parlay`}
                subtitle={
                  added.length > 0
                    ? `${RESULT_SUBTITLE}. Only ${parlayA!.available} game${plural(parlayA!.available)} had picks, so ${added.length} same-game leg${plural(added.length)} ${added.length === 1 ? "was" : "were"} added.`
                    : RESULT_SUBTITLE + builtFromText(builtInclude, builtMix, parlayA!.requested)
                }
                plain
                priceLegs={legPicks}
                sameGamePrice={added.length > 0}
                sendLegs={legPicks}
              >
                <ol className={LEG_LIST}>
                  {displayLegs.map((d, i) =>
                    d.kind === "TOP" ? (
                      <ParlayALeg key={d.leg.top.pick.pickId} n={i + 1} leg={d.leg} sameGame={d.sameGame} taken={taken} />
                    ) : (
                      <SameGameLegRow key={d.leg.pick.pickId} n={i + 1} leg={d.leg} />
                    )
                  )}
                </ol>
              </ResultBlock>
            )}
            {tab !== "PRIMARY" && swapNote && <p className="text-sm font-medium text-muted-foreground">{swapNote}</p>}
            {tab !== "PRIMARY" && !swapNote && added.length > 0 && (
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Same-game legs aren&apos;t included in swap variants: this is built from Parlay A&apos;s {parlayA!.legs.length} one-per-game leg
                {plural(parlayA!.legs.length)}.
              </p>
            )}
            {tab === "AUTO_HEDGE" && !swapNote && <SwapBlock parlay={result.hedge} plain />}
            {tab === "CONTRARIAN" && !swapNote && <SwapBlock parlay={result.contrarian} plain />}
          </div>
        </PanelShell>
      )}
    </>
  );
}
