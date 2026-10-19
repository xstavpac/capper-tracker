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
//
// A Generate answers with the Primary (Parlay A) and up to two alternates
// (lib/parlay/alternates.ts); Regenerate answers with up to three parlays not
// shown since the last Generate - the leg sets shown are session state here,
// sent back with each Regenerate. The Parlay slip's locks go into every one.
import { useEffect, useRef, useState } from "react";
import { autoGenerateParlayAction, type AutoGenerateResult } from "@/server/actions/parlay-generator";
import { CONTROL, FOOTER_LINK, FOOTER_TEXT, PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { BoltIcon, ListChecksIcon } from "@/components/dashboard/cappers-icons";
import { LABEL, LegStepper, NumberSegments, PILL_OUTLINE, PILL_PRIMARY, ScopeChip, Tabs, TextSegments } from "@/components/parlay/parlay-controls";
import { PickMixControl } from "@/components/parlay/pick-mix-control";
import { INCLUDE_PICKS_OPTIONS, mixLabel, mixSplit, type IncludePicks } from "@/lib/parlay/pick-mix";
import { LEG_LIST, LegRow, ResultBlock, SwapBlock, formatOdds, marketNoun, rankedRecordText, rankedWhy } from "@/components/parlay/swap-result";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import { autoGenerateWindowText } from "@/lib/parlay/auto-generate-window";
import type { AutoLeg, AutoParlay, MaxLegsPerGame, SameGameFill, SameGameLeg, SwapMode } from "@/lib/parlay/auto-generate";
import { legSetKey, NO_MORE_DISTINCT, type SlipHint } from "@/lib/parlay/parlay-set";
import { gameItemKey, useOptionalParlayPool } from "@/components/parlay/parlay-pool-context";
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

// "P0".."P2": the set's parlays, in order.
type ResultTab = `P${number}` | SwapMode;
const FIRST_TAB: ResultTab = "P0";

type SetParlay = { parlay: AutoParlay; sameGame: SameGameFill };

const SGP_TAG = "SGP";
const MAX_PER_GAME_OPTIONS = [1, 2, 3, 4, 5] as const;
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
    <LegRow
      n={n}
      pick={leg.top.pick}
      recordText={rankedRecordText(leg.top)}
      winPct={leg.top.record?.winPct ?? null}
      tag={leg.locked ? "Locked" : sameGame ? SGP_TAG : undefined}
      why={rankedWhy(leg.top, { locked: leg.locked, gameRank: leg.gameRank })}
    >
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
  const recordText = swapRecordLabel(leg.record, marketNoun(leg.pick.category));
  return (
    <LegRow
      n={n}
      pick={leg.pick}
      recordText={recordText}
      winPct={leg.record.winPct}
      tag={SGP_TAG}
      why={{ capperName: leg.pick.capperName, recordText, sample: leg.record.n }}
    >
      <p className="mt-1.5 text-[11.5px] font-medium text-muted-foreground">Added from a game already in this parlay</p>
    </LegRow>
  );
}

// One parlay of the set - the Primary or an alternate - with its same-game
// legs, its price and its own Send to FanDuel.
function SetParlayBlock({ title, item, builtFrom }: { title: string; item: SetParlay; builtFrom: string }) {
  const { parlay, sameGame } = item;
  const added = sameGame?.legs ?? [];
  const displayLegs = orderDisplayLegs(parlay.legs, added);
  const legPicks = displayLegs.map((d) => (d.kind === "TOP" ? d.leg.top.pick : d.leg.pick));
  const taken = new Set(added.map((a) => a.pick.pickId));
  return (
    <ResultBlock
      title={`${title} — ${displayLegs.length}-leg parlay`}
      subtitle={
        added.length > 0
          ? `${RESULT_SUBTITLE}. Only ${parlay.available} game${plural(parlay.available)} had picks, so ${added.length} same-game leg${plural(added.length)} ${added.length === 1 ? "was" : "were"} added.`
          : RESULT_SUBTITLE + builtFrom
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
  );
}

// The Parlay slip as Auto-Generate is told it: ids and locks only.
function useSlipHint(): { hint: SlipHint; key: string; nameOf: (key: string) => string } {
  const slip = useOptionalParlayPool();
  const picks = (slip?.pool ?? []).map((p) => ({ pickId: p.pickId, locked: slip!.isLocked(p.pickId) }));
  const games = (slip?.games ?? []).map((g) => ({ gameId: g.gameId, locked: slip!.isLocked(gameItemKey(g.gameId)) }));
  const key = [...picks, ...games].map((i) => ("pickId" in i ? i.pickId : "game:" + i.gameId) + (i.locked ? "!" : "")).join(",");
  const nameOf = (k: string) => {
    const game = slip?.games.find((g) => gameItemKey(g.gameId) === k);
    if (game) return game.gameLabel;
    const pick = slip?.pool.find((p) => p.pickId === k);
    return pick ? `${pick.capperName} — ${pick.betDetail}` : "a slip item";
  };
  return { hint: { picks, games }, key, nameOf };
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
  const [tab, setTab] = useState<ResultTab>(FIRST_TAB);
  // Every leg set shown since the last Generate (legSetKey), and how many
  // alternates that was - Regenerate never repeats one, and numbers on.
  const shownRef = useRef<string[]>([]);
  const [altsShown, setAltsShown] = useState(0);
  const [firstAlt, setFirstAlt] = useState(1);
  const [noMore, setNoMore] = useState(false);
  const slip = useSlipHint();

  const isInScope = (league: string) => scope[league] ?? true;
  const inScopeLeagues = leagues.filter(isInScope);
  const scopeKey = inScopeLeagues.join(",");

  // A result built for a different scope/leg count/slip no longer describes
  // the current selection - clear it rather than leave it on screen.
  useEffect(() => {
    setResult(null);
    setShortfallConfirmed(false);
    setTab(FIRST_TAB);
    setNoMore(false);
    shownRef.current = [];
  }, [scopeKey, legCount, maxPerGame, includePicks, appliedMix, slip.key]);

  useEffect(() => {
    onGenerated?.(result ? { gamesWithPicks: result.parlayA.available, leagues: result.leaguesSearched } : null);
  }, [result, onGenerated]);

  // Read leniently: a result without `parlays` is the Primary alone.
  const setOf = (r: AutoGenerateResult): SetParlay[] => r.parlays ?? [{ parlay: r.parlayA, sameGame: r.sameGame }];
  const keyOf = (p: SetParlay) => legSetKey([...p.parlay.legs.map((l) => l.top.pick.pickId), ...(p.sameGame?.legs ?? []).map((l) => l.pick.pickId)]);

  // A Generate starts the session over (the Primary again); a Regenerate
  // sends every leg set shown so far.
  async function generate(regenerate = false) {
    setBuilding(true);
    setError(null);
    try {
      const exclude = regenerate ? shownRef.current : null;
      const next = await autoGenerateParlayAction(inScopeLeagues, legCount, maxPerGame, includePicks, appliedMix, { slip: slip.hint, exclude });
      if ("error" in next) {
        const missing = "missing" in next && next.missing ? next.missing : [];
        setError(missing.length > 0 ? `${next.error} Not available: ${missing.map(slip.nameOf).join(", ")}.` : next.error);
        return;
      }
      const parlays = setOf(next);
      if (regenerate && parlays.length === 0) {
        // Nothing new: keep what is on screen and say so.
        setNoMore(true);
        return;
      }
      const alts = parlays.length - (regenerate ? 0 : 1);
      shownRef.current = [...(regenerate ? shownRef.current : []), ...parlays.map(keyOf)];
      setFirstAlt(regenerate ? altsShown + 1 : 1);
      setAltsShown((n) => (regenerate ? n : 0) + alts);
      setNoMore(next.exhausted === true);
      setResult(next);
      setShortfallConfirmed(false);
      setTab(FIRST_TAB);
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
    setTab(FIRST_TAB);
    setNoMore(false);
    shownRef.current = [];
  }

  const parlayA = result?.parlayA ?? null;
  // Read leniently: a result with no same-game part is a one-leg-per-game parlay.
  const added = result?.sameGame?.legs ?? [];
  const builtMax = result?.sameGame?.maxLegsPerGame ?? 1;
  const displayLegs = parlayA ? orderDisplayLegs(parlayA.legs, added) : [];
  const legPicks = displayLegs.map((d) => (d.kind === "TOP" ? d.leg.top.pick : d.leg.pick));
  const setParlays = result ? setOf(result) : [];
  const regenerated = result?.regenerated === true;
  // A first Generate: Parlay A, then Alt 1 and Alt 2. A Regenerate numbers on.
  const tabLabel = (i: number) => (!regenerated && i === 0 ? "Primary" : "Alt " + (regenerated ? firstAlt + i : i));
  const blockTitle = (i: number) => (!regenerated && i === 0 ? "Parlay A" : "Alternate " + (regenerated ? firstAlt + i : i));
  const isSwapTab = tab === "AUTO_HEDGE" || tab === "CONTRARIAN";
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
            <button type="button" onClick={() => generate()} disabled={inScopeLeagues.length === 0 || building} className={PILL_PRIMARY}>
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
            subtitle: result.regenerated
              ? "Parlays you haven't seen yet, and Hedge and Contrarian of the first"
              : "Parlay A, two alternates, and Parlay A's Hedge and Contrarian variants",
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
              <button
                type="button"
                onClick={() => generate(true)}
                disabled={building || noMore}
                className={FOOTER_LINK + " px-1 py-2.5 disabled:opacity-50 " + TINTS.neutral.accent}
              >
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
              ...setParlays.map((_, i) => ({ key: `P${i}` as ResultTab, label: tabLabel(i) })),
              { key: "AUTO_HEDGE", label: "Hedge", note: swapNote ? undefined : result.hedge.swapCount + "/" + result.hedge.legs.length },
              { key: "CONTRARIAN", label: "Contrarian", note: swapNote ? undefined : result.contrarian.swapCount + "/" + result.contrarian.legs.length },
            ]}
          />
          {noMore && <p className="mt-2 text-xs font-medium text-muted-foreground">{NO_MORE_DISTINCT}.</p>}
          <div className="mt-3">
            {setParlays.map(
              (item, i) =>
                tab === `P${i}` && (
                  <SetParlayBlock
                    key={keyOf(item)}
                    title={blockTitle(i)}
                    item={item}
                    builtFrom={builtFromText(builtInclude, builtMix, item.parlay.requested)}
                  />
                )
            )}
            {isSwapTab && swapNote && <p className="text-sm font-medium text-muted-foreground">{swapNote}</p>}
            {isSwapTab && !swapNote && added.length > 0 && (
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Same-game legs aren&apos;t included in swap variants: this is built from {blockTitle(0)}&apos;s {parlayA!.legs.length} one-per-game leg
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
