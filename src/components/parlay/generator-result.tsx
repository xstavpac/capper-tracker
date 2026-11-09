"use client";

// The Parlay Generator's result: "Your parlay · N legs", its Primary / Hedge /
// Contrarian tabs, Regenerate, and Send to FanDuel for whichever tab is open.
// Renders a GeneratedParlay (lib/parlay/generator.ts) as built - nothing is
// chosen here.
//
//   - Every leg shows its record as W-L (win %), so the sample size is in plain
//     sight. A slip pick says it's yours; a leg whose game has another leg is
//     tagged SGP.
//   - Combined odds only for a parlay with no same-game legs: legs on one game
//     aren't independent, and FanDuel prices them itself.
//   - Hedge and Contrarian swap the legs the "Swap:" control (on those two tabs
//     only) covers: Suggested (generated legs), Your picks (slip legs) or All.
//     The Primary always keeps every slip pick as chosen.
//   - Generate / Regenerate build the card pick by pick (use-build-reveal.ts):
//     an analyzing step, then the engine's legs one at a time, in their order,
//     with the combined price of the legs shown so far, then PARLAY COMPLETE.
//     Presentation only - every leg and price is the engine's answer.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { getRecordColor, PICK_CATEGORY_LABELS, PICK_CATEGORY_MARKET_NOUN } from "@/server/data/stats";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { GREEN, MUTED, RED } from "@/components/dashboard/stat-card";
import { CONTROL, PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { WIN_PCT_TRACK, WinPctBar } from "@/components/dashboard/category-card";
import { ClipboardIcon, ListChecksIcon, RefreshIcon } from "@/components/dashboard/cappers-icons";
import { LABEL, SEGMENT_OFF, SEGMENT_ON, Tabs, TextSegments } from "@/components/parlay/parlay-controls";
import { SendToFanDuel } from "@/components/parlay/send-to-fanduel";
import { combineOdds, decimalToAmerican, formatAmericanOdds, formatDecimalOdds, formatPayout, hasUsablePrice, payoutOn, type CombineLeg } from "@/lib/parlay/combine-odds";
import { ANALYZING_STATUS, completeText, easeOut, LAND_MS, ODDS_TWEEN_MS } from "@/lib/parlay/build-reveal";
import { prefersReducedMotion, type Reveal } from "@/components/parlay/use-build-reveal";
import { isGameLive, LIVE_NOTE, type GameClock } from "@/lib/parlay/game-over";
import { autoPickNext, defaultSwapTab, type EngineLeg, type EngineSwap, type EngineSwapLeg, type GeneratedParlay, type LegAlternatives, type LegRecord, type SwapTab } from "@/lib/parlay/generator";
import type { RankRecordSource } from "@/lib/parlay/pick-record";
import { PROP_MARKET_LABELS, type PropMarketKey } from "@/lib/prop-market-key";
import { SELECTION_MODES, type SelectionMode } from "@/lib/parlay/selection";
import { SWAP_SCOPE_OPTIONS, type SwapScope } from "@/lib/parlay/swap-scope";
import { noAlternativeText, pickSummary, regenerateState, unusedLine, unusedPicks, type NoAlternativeReason } from "@/lib/parlay/subset-ui";

export const formatOdds = (odds: number) => (odds > 0 ? "+" : "") + odds;
export const formatGameTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const plural = (n: number) => (n === 1 ? "" : "s");
const LEG_LIST = "divide-y divide-[#0F1420]/[0.06] dark:divide-white/10";
const TAG = "ml-1.5 rounded-full px-1.5 py-px text-[10px] font-bold";

// "62% (106–65)" plus what the record is: "· NFL favorite spread" (this
// league, this market), "· all leagues favorite spread" (this market, every
// league) or "· last 20 picks" (a slip pick's card, nothing better). A
// generated prop gated on its per-market record (`propMarket`) names that
// market - "· NBA points" - not its category's "player prop".
export function recordText(record: LegRecord | null, basis: EngineLeg["basis"], pick: Pick<ExpanderPick, "category" | "leagueName">, propMarket?: PropMarketKey): string {
  if (!record) return "No record yet";
  const base = `${Math.round(record.winPct)}% (${record.wins}–${record.losses})`;
  const market = propMarket ? PROP_MARKET_LABELS[propMarket] : pick.category ? PICK_CATEGORY_MARKET_NOUN[pick.category] : "this market";
  if (basis === "LEAGUE") return `${base} · ${pick.leagueName} ${market}`;
  if (basis === "OVERALL" || basis === "MARKET") return `${base} · all leagues ${market}`;
  if (basis === "LAST20") return `${base} · last 20 picks`;
  return base;
}

// A leg the open variant swapped in: a 1.5px accent frame (an inset ring, so
// the thicker edge moves nothing), a faint accent wash, and a soft halo. The
// -mx/px pair pushes the frame out 10px and keeps the text where it was; the
// panel's 14px padding holds the frame and halo. The frame alone is the signal.
const SWAPPED_FRAME =
  "-mx-2.5 rounded-xl px-2.5 bg-brand-600/[0.06] ring-[1.5px] ring-inset ring-brand-600 shadow-[0_0_0_3px_var(--tw-shadow-color)] shadow-brand-600/[0.12] dark:bg-brand-400/[0.08] dark:ring-brand-400 dark:shadow-brand-400/[0.12]";
const SWAPPED_TEXT = "text-brand-700 dark:text-brand-300";
// A leg just added by the pick-by-pick build: it slides up and fades in with the
// swap highlight (SWAPPED_FRAME), which then fades to the normal row - the same
// frame with every colour transparent, so the shadow and ring transition smoothly.
const ARRIVED_FRAME = "-mx-2.5 rounded-xl px-2.5 bg-transparent ring-[1.5px] ring-inset ring-transparent shadow-[0_0_0_3px_var(--tw-shadow-color)] shadow-transparent";
const ARRIVE_MOTION = "animate-leg-land transition-[background-color,box-shadow] duration-[1900ms] ease-out motion-reduce:animate-none motion-reduce:transition-none";

function LegRow({
  n,
  pick,
  record,
  mine,
  sgp,
  swappedBy,
  arrive,
  handSwapped,
  action,
  overlay,
  children,
}: {
  n: number;
  pick: ExpanderPick;
  record: { text: string; winPct: number | null };
  mine: boolean;
  sgp: boolean;
  swappedBy?: string;
  arrive?: boolean;
  // Chosen by hand from this leg's swap tray: a small "Swapped" tag.
  handSwapped?: boolean;
  // The leg's Swap button, under the odds.
  action?: ReactNode;
  // Covers the row while a hand swap finds its pick.
  overlay?: ReactNode;
  children?: ReactNode;
}) {
  const tone = record.winPct === null ? MUTED : getRecordColor(record.winPct) === "green" ? GREEN : RED;
  const live = isGameLive(pick, new Date());
  // Lit from the moment it lands; the highlight starts fading once the slide-in is done.
  const [lit, setLit] = useState(Boolean(arrive));
  useEffect(() => {
    if (!arrive) return;
    const t = setTimeout(() => setLit(false), LAND_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the row lands
  }, []);
  const highlighted = Boolean(swappedBy) || (arrive && lit);
  const frame = swappedBy ? SWAPPED_FRAME : arrive ? (lit ? SWAPPED_FRAME : ARRIVED_FRAME) + " " + ARRIVE_MOTION : "";
  const textTone = (highlighted ? SWAPPED_TEXT : "text-foreground") + (arrive ? " transition-colors duration-[1900ms] motion-reduce:transition-none" : "");
  return (
    <li className={"flex gap-3 py-3 " + (overlay ? "relative " : "") + frame} aria-busy={overlay ? true : undefined}>
      {overlay}
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-banner text-xs font-bold tabular-nums text-white">{n}</span>
      <div className="min-w-0 flex-1">
        <p className={LABEL}>
          {pick.leagueName} · {pick.gameLabel} · {formatGameTime(pick.gameTime)}
          {live && <span className={TAG + " bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"}>Live</span>}
          {sgp && <span className={TAG + " bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400"}>SGP</span>}
          {mine && (
            <span className={TAG + " inline-flex items-center gap-1 bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"} title="One of your picks - in every parlay">
              <ClipboardIcon className="h-3 w-3 stroke-[2.4]" />
              Your pick
            </span>
          )}
          {handSwapped && (
            <span data-swapped-tag className={TAG + " bg-brand-600/10 text-brand-700 dark:bg-brand-400/15 dark:text-brand-300"}>
              Swapped
            </span>
          )}
        </p>
        <div className="mt-0.5 flex items-baseline justify-between gap-3">
          <p className={"min-w-0 text-[15px] font-bold leading-snug [overflow-wrap:anywhere] " + textTone}>
            {swappedBy && <span className="sr-only">Swapped by {swappedBy}: </span>}
            {pick.betDetail}
          </p>
          <p className={"shrink-0 text-sm font-semibold tabular-nums " + textTone}>{formatOdds(pick.odds)}</p>
        </div>
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-xs font-medium text-muted-foreground">
            <Link href={"/cappers/" + pick.capperId} className="text-foreground hover:underline">
              {pick.capperName}
            </Link>
            {pick.category && " · " + PICK_CATEGORY_LABELS[pick.category]}
          </p>
          {action}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <p className={"text-[11.5px] font-semibold tabular-nums " + tone}>{record.text}</p>
          <WinPctBar winPct={record.winPct ?? 0} decided={record.winPct !== null} className={"w-24 " + WIN_PCT_TRACK} />
        </div>
        {live && <p className="mt-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">{LIVE_NOTE}</p>}
        {children}
      </div>
    </li>
  );
}

const NOTE = "mt-1.5 text-[11.5px] font-medium text-muted-foreground";
const SWAP_COPY = {
  AUTO_HEDGE: { title: "Hedge", verb: "hedged", noAlternate: "no other bet on this game clears your bar in its market and fits" },
  CONTRARIAN: { title: "Contrarian", verb: "flipped", noAlternate: "no pick on the other side of this bet clears your bar" },
} as const;

function SwapLegRow({ n, leg, mode }: { n: number; leg: EngineSwapLeg; mode: EngineSwap["mode"] }) {
  const { original } = leg;
  if (!leg.swap) {
    const reason =
      leg.unchangedReason === "OUT_OF_SCOPE"
        ? original.source === "SLIP" || original.handSwapped
          ? (original.source === "SLIP" ? "your pick" : "your swapped-in pick") + " - Swap is set to Suggested"
          : "suggested leg - Swap is set to Your picks"
        : leg.unchangedReason === "NOT_MAJORITY"
          ? "your pick's side isn't the majority of your cappers"
          : SWAP_COPY[mode].noAlternate;
    return (
      <LegRow n={n} pick={original.pick} record={{ text: recordText(original.record, original.basis, original.pick, original.propMarket), winPct: original.record?.winPct ?? null }} mine={original.source === "SLIP"} sgp={original.sameGame}>
        <p className={NOTE}>
          <span className="rounded-full bg-muted px-1.5 py-0.5 font-semibold">Unchanged</span> {reason}
        </p>
      </LegRow>
    );
  }
  const { swap } = leg;
  return (
    <LegRow n={n} pick={swap.pick} record={{ text: recordText(swap.record, swap.basis ?? "MARKET", swap.pick, swap.propMarket), winPct: swap.record.winPct }} mine={false} sgp={original.sameGame} swappedBy={SWAP_COPY[mode].title}>
      <p className={NOTE}>
        Replaces {original.source === "SLIP" && "your pick "}
        <span className="line-through">{original.pick.betDetail}</span> · {original.pick.capperName}
      </p>
    </LegRow>
  );
}

// ---- Swap one leg by hand (the leg's swap tray) ---------------------------------
// The tray's alternatives are the engine's (legAlternatives, generator.ts); this
// only shows them and says which one was chosen.
export const SWAP_OVERLAY_MS = 750;
export const SWAP_FINDING = "Finding another eligible pick…";
export const swappingStatus = (n: number) => `Re-scoring leg ${n} · ${SWAP_FINDING}`;
export const swappedStatus = (n: number) => `Leg ${n} swapped · Combined odds updated`;
export const SWAP_TRAY_ROWS = 3;
export const SWAP_EMPTY: Record<SwapTab, string> = {
  THIS_GAME: "No other eligible picks on this game.",
  OTHER_GAMES: "No other eligible games with your current filters.",
};
const SWAP_TAB_LABELS: Record<SwapTab, string> = { THIS_GAME: "This game", OTHER_GAMES: "Other games" };
const swapSubtitle = (tab: SwapTab, matchup: string) => (tab === "THIS_GAME" ? `Other eligible picks on ${matchup}` : `Replaces ${matchup} with a game not in your parlay`);

function SwapArrowsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M7 4L3 8l4 4" />
      <path d="M3 8h13a4 4 0 0 1 4 4" />
      <path d="M17 20l4-4-4-4" />
      <path d="M21 16H8a4 4 0 0 1-4-4" />
    </svg>
  );
}

// The small pill under a leg's odds; an invisible 10px above and below makes the tap target 42px.
const SWAP_PILL =
  "relative inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold transition after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-['']";
const SWAP_PILL_OFF = "border-[#DADDE5] bg-white text-foreground hover:border-brand-600 hover:text-brand-600 dark:border-border dark:bg-card dark:hover:border-brand-400 dark:hover:text-brand-400";
const SWAP_PILL_ON = "border-brand-600 bg-brand-600 text-white dark:border-brand-400 dark:bg-brand-400 dark:text-[#0F1420]";

function SwapButton({ n, open, trayId, onClick }: { n: number; open: boolean; trayId: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-swap-button
      onClick={onClick}
      aria-expanded={open}
      aria-controls={open ? trayId : undefined}
      aria-label={open ? `Close the swap tray for leg ${n}` : `Swap leg ${n}`}
      className={SWAP_PILL + " " + (open ? SWAP_PILL_ON : SWAP_PILL_OFF)}
    >
      <SwapArrowsIcon className="h-3 w-3" />
      {open ? "Close" : "Swap"}
    </button>
  );
}

function SwapOverlay() {
  return (
    <div data-swap-overlay className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-white/90 dark:bg-card/90">
      <p className="text-xs font-semibold text-foreground">{SWAP_FINDING}</p>
      <div aria-hidden="true" className="relative h-1 w-28 overflow-hidden rounded-full bg-[#0F1420]/[0.07] dark:bg-white/10">
        <span className="absolute inset-y-0 left-0 w-1/2 animate-build-shimmer bg-gradient-to-r from-transparent via-brand-500 to-transparent" />
      </div>
    </div>
  );
}

const TRAY_BUTTON = "inline-flex min-h-[40px] items-center justify-center rounded-full px-3.5 text-xs font-semibold transition disabled:opacity-50";

function SwapTray({
  id,
  n,
  matchup,
  alternatives,
  tab,
  onTab,
  favoritesOnly,
  onUse,
  onKeep,
}: {
  id: string;
  n: number;
  matchup: string;
  alternatives: LegAlternatives;
  tab: SwapTab;
  onTab: (t: SwapTab) => void;
  favoritesOnly: boolean;
  onUse: (pickId: string) => void;
  onKeep: () => void;
}) {
  const rows = (tab === "THIS_GAME" ? alternatives.thisGame : alternatives.otherGames).slice(0, SWAP_TRAY_ROWS);
  const next = autoPickNext(alternatives, tab);
  return (
    <div id={id} data-swap-tray role="region" aria-label={`Swap leg ${n}`} className="mt-2.5 animate-tray-down rounded-xl bg-[#F4F5F8] p-3 motion-reduce:animate-none dark:bg-white/[0.06]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-xs font-semibold text-foreground">Swap leg {n} · eligible picks not already in this parlay</p>
        <p className="text-[11px] font-semibold text-muted-foreground">{favoritesOnly ? "★ Favorites only" : "All cappers"}</p>
      </div>
      <div className="mt-2">
        <Tabs<SwapTab>
          label={`Swap leg ${n} from`}
          value={tab}
          onChange={onTab}
          tabs={[
            { key: "THIS_GAME", label: SWAP_TAB_LABELS.THIS_GAME, note: String(alternatives.thisGame.length) },
            { key: "OTHER_GAMES", label: SWAP_TAB_LABELS.OTHER_GAMES, note: String(alternatives.otherGames.length) },
          ]}
        />
      </div>
      <p data-swap-subtitle className="mt-2 text-[11.5px] font-medium text-muted-foreground [overflow-wrap:anywhere]">
        {swapSubtitle(tab, matchup)}
      </p>
      {rows.length === 0 ? (
        <p data-swap-empty className="mt-2 text-xs font-medium text-foreground">
          {SWAP_EMPTY[tab]}
        </p>
      ) : (
        <ul className="mt-1.5 divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
          {rows.map((l) => (
            <li key={l.pick.pickId} data-swap-alternative={l.pick.pickId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
              <div className="min-w-0 flex-1 basis-48">
                <p className={LABEL + " [overflow-wrap:anywhere]"}>
                  {l.pick.leagueName} · {l.gameLabel} · {formatGameTime(l.gameTime)}
                </p>
                <p className="text-sm font-bold leading-snug text-foreground [overflow-wrap:anywhere]">{l.pick.betDetail}</p>
                <p className="text-[11.5px] font-medium text-muted-foreground [overflow-wrap:anywhere]">
                  {l.pick.capperIsFavorite && (
                    <span className="mr-0.5 text-[#f59e0b]" aria-label="Favorite capper">
                      ★
                    </span>
                  )}
                  {l.pick.capperName} · {recordText(l.record, l.basis, l.pick, l.propMarket)}
                </p>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2.5">
                <span className="text-sm font-semibold tabular-nums text-foreground">{formatOdds(l.pick.odds)}</span>
                <button type="button" onClick={() => onUse(l.pick.pickId)} aria-label={`Use ${l.pick.betDetail} for leg ${n}`} className={TRAY_BUTTON + " bg-brand-600 text-white hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-400"}>
                  Use
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={onKeep} className={TRAY_BUTTON + " border border-[#DADDE5] bg-white text-foreground hover:bg-[#0F1420]/[0.03] dark:border-border dark:bg-card"}>
          Keep this leg
        </button>
        <button type="button" disabled={!next} onClick={() => next && onUse(next.pick.pickId)} className={TRAY_BUTTON + " border border-brand-600 bg-white text-brand-600 hover:bg-brand-600/[0.06] dark:border-brand-400 dark:bg-card dark:text-brand-400"}>
          Auto-pick next best
        </button>
      </div>
    </div>
  );
}

function PriceCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className={LABEL}>{label}</dt>
      <dd className="mt-0.5 text-[15px] font-bold tabular-nums leading-snug text-foreground [overflow-wrap:anywhere]">
        {value}
        {sub && <span className="ml-1 text-xs font-medium text-muted-foreground">{sub}</span>}
      </dd>
    </div>
  );
}

const PRICE_BOX = "mt-2.5 rounded-[12px] border border-[#E6E8EF] bg-white px-3.5 py-2.5 dark:border-border dark:bg-card";

// The parlay's price as built (lib/parlay/combine-odds.ts), with its two
// honest exceptions said in words: a leg with no price (no number at all) and
// legs at the importer's -110 placeholder (shown, marked "≈"). A parlay with
// same-game legs gets no number: FanDuel prices those together.
//
// `tween` (the pick-by-pick build): a new combined price eases from the one shown
// before (ODDS_TWEEN_MS). Only the shown decimal moves; the American odds and the
// payout are derived from it with combine-odds.ts's own helpers, and every value
// lands exactly on combineOdds()'s. Unavailable / Priced at FanDuel never tween.
function useTweenedDecimal(target: number | null, on: boolean): number | null {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (!on || target === null || from.current === null) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = from.current;
    const t0 = performance.now();
    let raf = 0;
    // performance.now(), not the frame's timestamp: the two need not share an origin.
    const step = () => {
      const k = easeOut((performance.now() - t0) / ODDS_TWEEN_MS);
      const v = k >= 1 ? target : start + (target - start) * k;
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, on]);
  return on ? shown : target;
}

export function CombinedPrice({ legs, sameGame, tween = false }: { legs: (CombineLeg & Partial<GameClock>)[]; sameGame: boolean; tween?: boolean }) {
  const combined = combineOdds(legs);
  const shownDecimal = useTweenedDecimal(!sameGame && combined.status === "AVAILABLE" ? combined.decimal : null, tween);
  // A leg on a game under way is priced as posted; its odds may have moved.
  const now = new Date();
  const isLive = (l: CombineLeg & Partial<GameClock>) => l.gameTime !== undefined && isGameLive({ gameTime: l.gameTime, gameStatus: l.gameStatus, gameId: l.gameId }, now);
  const liveNote = legs.some(isLive) ? <p className="mt-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">{LIVE_NOTE}</p> : null;
  if (sameGame) {
    return (
      <div className={PRICE_BOX}>
        <p className={LABEL}>Combined odds</p>
        <p className="mt-0.5 text-sm font-semibold text-foreground">Priced at FanDuel</p>
        <p className="text-xs font-medium text-muted-foreground">Same-game legs aren&apos;t independent, so FanDuel prices this parlay itself.</p>
        {liveNote}
      </div>
    );
  }
  if (combined.legCount === 0) return null;
  if (combined.status === "UNAVAILABLE") {
    return (
      <div className={PRICE_BOX}>
        <p className={LABEL}>Combined odds</p>
        <p className="mt-0.5 text-sm font-semibold text-foreground">Unavailable</p>
        <p className="text-xs font-medium text-muted-foreground">
          {combined.unavailableLegs > 0 && legs.some((l) => isLive(l) && !hasUsablePrice(l.odds))
            ? "A live leg has no price, so this parlay can't be priced - check FanDuel."
            : combined.unavailableLegs > 0
            ? `${combined.unavailableLegs} leg${plural(combined.unavailableLegs)} ${combined.unavailableLegs === 1 ? "has" : "have"} no price, so this parlay can't be priced.`
            : "This parlay's price is too large to show."}
        </p>
        {liveNote}
      </div>
    );
  }
  const approx = combined.estimated ? "≈ " : "";
  const asPosted = legs.some(isLive) ? " (as posted)" : "";
  // Mid-tween: the shown decimal, the rest derived from it. Otherwise exactly combineOdds()'s.
  const midTween = shownDecimal !== null && shownDecimal !== combined.decimal;
  const price = midTween ? { ...combined, decimal: shownDecimal, american: decimalToAmerican(shownDecimal) ?? combined.american } : combined;
  return (
    <div className={PRICE_BOX}>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
        <PriceCell label={(combined.estimated ? "Combined odds (estimate)" : "Combined odds") + asPosted} value={approx + formatAmericanOdds(price.american)} />
        <PriceCell label="Decimal" value={approx + formatDecimalOdds(price.decimal)} />
        <PriceCell label="Payout" value={approx + formatPayout(payoutOn(price))} sub="on $1" />
      </dl>
      {combined.estimated && (
        <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
          Estimate: {combined.defaultedLegs} of {combined.legCount} leg{plural(combined.legCount)} had no posted price and{" "}
          {combined.defaultedLegs === 1 ? "is" : "are"} counted at a placeholder -110.
        </p>
      )}
      {liveNote}
    </div>
  );
}

// Your picks only with more picks than Total legs: the picks this parlay left out, one collapsed line
// ("13 picks not used this time") that opens to the list. Another Regenerate may use them.
export function UnusedPicks({ picks }: { picks: { pickId: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  if (picks.length === 0) return null;
  return (
    <div className="mb-2 text-xs font-medium text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex min-h-[44px] items-center gap-1 font-semibold text-foreground hover:underline sm:min-h-0"
      >
        <span aria-hidden="true" className={"inline-block transition-transform " + (open ? "rotate-90" : "")}>›</span>
        {unusedLine(picks.length)}
      </button>
      {open && (
        <ul className="list-disc pl-5">
          {picks.map((p) => (
            <li key={p.pickId} className="[overflow-wrap:anywhere]">
              {p.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The header's Regenerate: an accent-outlined pill exactly as tall as the "N legs" chip (26px), with an
// invisible 10px of hit area above and below (from inside the 1px border) so the tap target is 44px.
const REGENERATE =
  "relative inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-brand-600 bg-white px-2.5 py-1 text-xs font-semibold text-brand-600 transition hover:bg-brand-600/[0.06] disabled:opacity-50 dark:border-brand-400 dark:bg-card dark:text-brand-400 dark:hover:bg-brand-400/10 after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-['']";

export const MODE_LABELS: Record<SelectionMode, string> = { BEST: "Best", DIVERSIFIED: "Diversified", EXPLORE: "Explore" };
// One line under the header per mode; Regenerate only (Generate stays the same parlay).
export const MODE_HELP: Record<SelectionMode, string> = {
  BEST: "Strongest legs first. Regenerates stay close to your top parlay. Applies on your next Regenerate.",
  DIVERSIFIED: "Mostly strong legs, with variety. Recently used legs are less likely to repeat. Applies on your next Regenerate.",
  EXPLORE: "Wider mix. Gives more legs a chance, including lower-ranked ones. Applies on your next Regenerate.",
};
export const LIMITED_TITLE = (have: number, need: number) => `Only ${have} of ${need} legs clear your bar right now.`;
export const LIMITED_BODY = "Lower Minimum Capper Win Rate, widen Bet Types, or switch on more leagues to add legs. Your bar stays where you set it.";

// The header's mode picker: the same pill as the Regenerate button's height (26px) with a 44px tap target.
function ModePicker({ value, onChange, disabled }: { value: SelectionMode; onChange: (m: SelectionMode) => void; disabled: boolean }) {
  return (
    <div role="radiogroup" aria-label="Regenerate mode" className="flex shrink-0 items-center gap-0.5 rounded-full border border-[#DADDE5] bg-white p-0.5 dark:border-border dark:bg-card">
      {SELECTION_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={m === value}
          disabled={disabled}
          onClick={() => onChange(m)}
          className={"relative flex h-[22px] items-center justify-center whitespace-nowrap rounded-full px-2 text-xs font-semibold transition disabled:opacity-50 after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] " + (m === value ? SEGMENT_ON : SEGMENT_OFF)}
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

type Tab = "PRIMARY" | "AUTO_HEDGE" | "CONTRARIAN";
const sendLegs = (picks: ExpanderPick[]) => picks.map((p) => ({ pickId: p.pickId, betDetail: p.betDetail, gameId: p.gameId, gameLabel: p.gameLabel }));

// The build's progress: the scan line under the header (while building), the bar
// (revealed / total) and the status line, its dot pulsing until the parlay is done.
function BuildProgress({ revealed, total, status, active }: { revealed: number; total: number; status: string; active: boolean }) {
  const pct = total > 0 ? Math.round((Math.min(revealed, total) / total) * 100) : 0;
  return (
    <div data-build-progress className="mb-2">
      {active && (
        <div aria-hidden="true" className="relative -mt-1.5 mb-2 h-0.5 overflow-hidden rounded-full">
          <span className="absolute inset-y-0 left-0 w-1/3 animate-build-scan bg-gradient-to-r from-transparent via-brand-500 to-transparent motion-reduce:hidden" />
        </div>
      )}
      <div role="progressbar" aria-label="Parlay build progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={revealed} className="h-1.5 overflow-hidden rounded-full bg-[#0F1420]/[0.06] dark:bg-white/10">
        <div className="h-full rounded-full bg-brand-600 transition-[width] duration-500 ease-out motion-reduce:transition-none dark:bg-brand-400" style={{ width: pct + "%" }} />
      </div>
      <p role="status" aria-live="polite" className="mt-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span aria-hidden="true" className={"h-2 w-2 shrink-0 rounded-full bg-brand-600 dark:bg-brand-400 " + (active ? "animate-pulse motion-reduce:animate-none" : "")} />
        {status}
      </p>
    </div>
  );
}

// A leg still to come: the row's shape, shimmering.
function PlaceholderLeg() {
  const bar = "rounded-full bg-[#0F1420]/[0.07] dark:bg-white/10";
  return (
    <li aria-hidden="true" data-placeholder-leg className="relative flex gap-3 overflow-hidden py-3">
      <span className={"h-7 w-7 shrink-0 " + bar} />
      <div className="min-w-0 flex-1 space-y-2 py-0.5">
        <span className={"block h-2.5 w-2/5 " + bar} />
        <span className={"block h-3.5 w-3/4 " + bar} />
        <span className={"block h-2.5 w-1/3 " + bar} />
      </div>
      <span className="pointer-events-none absolute inset-y-0 left-0 w-1/2 animate-build-shimmer bg-[linear-gradient(100deg,transparent_0%,rgba(255,255,255,0.7)_50%,transparent_100%)] motion-reduce:hidden dark:bg-[linear-gradient(100deg,transparent_0%,rgba(255,255,255,0.08)_50%,transparent_100%)]" />
    </li>
  );
}

// The ready title's small blue check, in the header's icon tile.
function ReadyCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-[17px] w-[17px] text-brand-600 dark:text-brand-400">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

const BUILDING_TITLE = "Building your parlay";
export const READY_TITLE = "Your parlay is ready";
const COUNTER = CONTROL + " shrink-0 px-2.5 py-1 tabular-nums " + TINTS.neutral.control;
const COMPLETE_BANNER = "mt-2.5 scroll-mb-4 rounded-[12px] border border-brand-600/25 bg-brand-600/[0.06] px-3.5 py-2.5 dark:border-brand-400/30 dark:bg-brand-400/[0.08]";
const scrollNearest = (el: HTMLElement | null) => el?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });

export function GeneratorResult({
  parlay,
  reveal,
  requestedLegs,
  favoritesOnly = false,
  busy,
  noAlternative,
  unavailableTargetLabels,
  swapScope,
  onSwapScope,
  onRegenerate,
  selectionMode,
  onSelectionMode,
  onSent,
  legSwap,
}: {
  // Null only while a build is analyzing and the engine hasn't answered yet.
  parlay: GeneratedParlay | null;
  // The pick-by-pick build (use-build-reveal.ts); null: the parlay as built, all at once.
  reveal: Reveal | null;
  // Total legs, for the counter until the engine says how many it found.
  requestedLegs: number;
  // The Favorites only star was on for this build: a small pill after the title.
  favoritesOnly?: boolean;
  busy: boolean;
  // Which legs Hedge and Contrarian swap (swap-scope.ts); remembered by the card.
  swapScope: SwapScope;
  onSwapScope: (scope: SwapScope) => void;
  // Why the last Regenerate couldn't vary the parlay (subset-ui.ts); null when it could.
  noAlternative: NoAlternativeReason | null;
  // Targeted games that are over or have left the board, by name.
  unavailableTargetLabels: string[];
  onRegenerate: () => void;
  // Best / Diversified / Explore: how the next Regenerate draws (the card remembers it).
  selectionMode: SelectionMode;
  onSelectionMode: (m: SelectionMode) => void;
  // The user opened FanDuel's betslip with this parlay.
  onSent: () => void;
  // Swapping one leg by hand (the card's session, on its snapshot): a leg's
  // alternatives, and replacing it with one - false when it no longer can.
  // Absent: no Swap buttons.
  legSwap?: {
    alternatives: (legIndex: number) => LegAlternatives;
    apply: (legIndex: number, pickId: string) => boolean;
  };
}) {
  const [tab, setTab] = useState<Tab>("PRIMARY");
  // The one open swap tray, and its tab.
  const [tray, setTray] = useState<{ index: number; tab: SwapTab } | null>(null);
  // The leg under the "Finding another eligible pick…" overlay.
  const [swapping, setSwapping] = useState<number | null>(null);
  const [swapStatus, setSwapStatus] = useState<string | null>(null);
  // The leg a hand swap just replaced: its new row lands with the build's highlight.
  const [landed, setLanded] = useState<number | null>(null);
  // Combined odds ease to the new price after an animated swap.
  const [swapTween, setSwapTween] = useState(false);
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A parlay the card sent for another reason than this card's swap (a rebuild) clears the swap state.
  const ownSwap = useRef(false);
  useEffect(() => {
    if (ownSwap.current) {
      ownSwap.current = false;
      return;
    }
    if (swapTimer.current) clearTimeout(swapTimer.current);
    setTray(null);
    setSwapping(null);
    setSwapStatus(null);
    setLanded(null);
    setSwapTween(false);
  }, [parlay]);
  useEffect(() => () => void (swapTimer.current && clearTimeout(swapTimer.current)), []);
  // The Primary's rows play their landing once: after another tab, they come back as plain rows.
  const [leftPrimary, setLeftPrimary] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const oddsRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const phase = reveal?.phase ?? null;
  const revealed = reveal?.revealed ?? 0;

  // A build starts: the page brings the card into view. (The card is keyed per build, so this is once each.)
  useEffect(() => {
    if (reveal) cardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only
  }, []);
  // Each leg in: keep the newest leg and the combined price under it in view (page scroll).
  useEffect(() => {
    if (phase === "building" && revealed > 0) scrollNearest(oddsRef.current);
  }, [phase, revealed]);
  useEffect(() => {
    if (phase === "complete") scrollNearest(bannerRef.current);
  }, [phase]);

  // One tree for every phase, each part in a fixed place: the rows a build has landed
  // stay mounted when it completes (no second landing), and the scan line keeps running
  // from analyzing into building.
  const analyzing = !parlay || phase === "analyzing";
  const building = analyzing || phase === "building";
  const done = !building ? parlay : null;
  const legs = parlay?.legs ?? [];
  const total = analyzing ? (reveal?.total ?? requestedLegs) : legs.length;
  const shownLegs = analyzing ? [] : building ? legs.slice(0, revealed) : legs;
  // While building: Priced at FanDuel as soon as two shown legs share a game, as the full card would be.
  const gameIds = shownLegs.map((l) => l.gameId);
  const sameGame = done ? done.sameGameGames > 0 : new Set(gameIds).size < gameIds.length;

  const hedge = done?.hedge[swapScope];
  const contrarian = done?.contrarian[swapScope];
  const swap = tab === "AUTO_HEDGE" ? hedge : tab === "CONTRARIAN" ? contrarian : undefined;
  const shownPicks = swap ? swap.legs.map((l) => (l.swap ?? l.original).pick) : shownLegs.map((l) => l.pick);
  const regenerate = done ? regenerateState(done, noAlternative) : null;
  // Swap one leg: the Primary tab of a finished build only, one swap at a time.
  const canSwap = Boolean(legSwap) && done !== null && !swap && swapping === null && !busy;
  const trayIndex = canSwap && tray && tray.index < legs.length ? tray.index : null;
  const alternatives = useMemo(
    () => (trayIndex !== null && legSwap ? legSwap.alternatives(trayIndex) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the legs on screen and the leg open
    [trayIndex, parlay]
  );
  const toggleTray = (index: number) => {
    if (trayIndex === index) return setTray(null);
    const alts = legSwap!.alternatives(index);
    setTray({ index, tab: defaultSwapTab(alts) });
  };
  const chooseAlternative = (index: number, pickId: string) => {
    setTray(null);
    const n = index + 1;
    const finish = () => {
      swapTimer.current = null;
      ownSwap.current = true;
      const ok = legSwap!.apply(index, pickId);
      if (!ok) ownSwap.current = false;
      setSwapping(null);
      setLanded(ok ? index : null);
      setSwapStatus(ok ? swappedStatus(n) : null);
    };
    // Reduced motion: replaced at once - no overlay, no tween.
    if (prefersReducedMotion()) {
      setSwapTween(false);
      finish();
      return;
    }
    setSwapTween(true);
    setSwapping(index);
    setSwapStatus(swappingStatus(n));
    swapTimer.current = setTimeout(finish, SWAP_OVERLAY_MS);
  };
  // The rows the build lands keep their (fading) highlight until another tab is opened.
  const arrive = reveal !== null && !leftPrimary;
  const placeholders = analyzing ? 2 : building && revealed < total ? 1 : 0;
  const notes = done
    ? [
        ...done.dropped.filter((d) => d.reason === "left_out").map((d) => `${d.label}: ${d.note}`),
        // LIMITED has its own banner for the "N of M legs" line; the targeted-game lines after it stay notes.
        ...(done.limited ? done.shortfall.slice(1) : done.shortfall),
        ...done.mixNotes,
        ...(unavailableTargetLabels.length > 0 ? [`${unavailableTargetLabels.join(", ")}: over or no longer on the board — not used.`] : []),
      ]
    : [];
  const subtitle = !parlay
    ? "Checking eligible picks against your filters"
    : `${parlay.gamesUsed} game${plural(parlay.gamesUsed)}` +
      (parlay.sameGameGames > 0 ? ` · ${parlay.sameGameGames} same-game pair${plural(parlay.sameGameGames)}` : "") +
      ` · ${pickSummary(parlay)}`;

  return (
    <div ref={cardRef} className="scroll-mt-4">
      <PanelShell
        theme={{
          ...TINTS.neutral,
          title: building ? BUILDING_TITLE : READY_TITLE,
          subtitle: analyzing ? "Checking eligible picks against your filters" : subtitle,
          icon: building ? <ListChecksIcon className="h-[17px] w-[17px] stroke-[2.2]" /> : <ReadyCheck />,
        }}
        titleBadge={
          favoritesOnly ? (
            <span data-favorites-pill className="ml-2 inline-flex items-center gap-0.5 rounded-full border border-[#f5c451] bg-[#fff7e0] px-2 py-px align-middle text-[11px] font-semibold text-[#b45309] dark:bg-amber-500/15 dark:text-amber-300">
              ★ Favorites
            </span>
          ) : undefined
        }
        control={
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
            {regenerate && (
              <>
                <ModePicker value={selectionMode} onChange={onSelectionMode} disabled={busy} />
                <button
                  type="button"
                  onClick={onRegenerate}
                  disabled={busy || regenerate.disabled}
                  title={regenerate.hint}
                  aria-label={"Regenerate: " + regenerate.hint}
                  className={REGENERATE}
                >
                  <RefreshIcon className="h-3.5 w-3.5 stroke-[2.4]" />
                  {busy ? "Regenerating…" : "Regenerate"}
                </button>
              </>
            )}
            <span className={COUNTER}>{building ? `${analyzing ? 0 : revealed} / ${total}` : `${legs.length} legs`}</span>
          </div>
        }
        footer={null}
        busy={busy}
        wrapSubtitle
        wrapControl
      >
        {reveal && (
          <BuildProgress
            revealed={analyzing ? 0 : building ? revealed : total}
            total={total}
            status={building ? reveal.status || ANALYZING_STATUS : (swapStatus ?? `${total} of ${total} selections added`)}
            active={building || swapping !== null}
          />
        )}
        {!reveal && swapStatus && (
          <p role="status" aria-live="polite" data-swap-status className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span aria-hidden="true" className={"h-2 w-2 shrink-0 rounded-full bg-brand-600 dark:bg-brand-400 " + (swapping !== null ? "animate-pulse motion-reduce:animate-none" : "")} />
            {swapStatus}
          </p>
        )}
        {done && <p className="mb-2 text-xs font-medium text-muted-foreground">{MODE_HELP[selectionMode]}</p>}
        {done?.limited && (
          <div role="status" data-limited className="mb-3 rounded-[12px] border border-amber-300 bg-amber-50/60 px-3.5 py-2.5 dark:border-amber-800 dark:bg-amber-500/10">
            <p className="text-xs font-semibold text-foreground">{LIMITED_TITLE(done.limited.have, done.limited.need)}</p>
            <p className="mt-0.5 text-xs font-medium text-muted-foreground">{LIMITED_BODY}</p>
          </div>
        )}
        {done && noAlternative && (
          <p role="status" className="mb-2 text-xs font-medium text-muted-foreground">
            {noAlternativeText(noAlternative)}
          </p>
        )}
        {done && <UnusedPicks picks={unusedPicks(done)} />}
        {hedge && contrarian && (
          <Tabs<Tab>
            label="Parlay variant"
            value={tab}
            onChange={(t) => {
              setTab(t);
              if (t !== "PRIMARY") setLeftPrimary(true);
            }}
            tabs={[
              { key: "PRIMARY", label: "Primary" },
              { key: "AUTO_HEDGE", label: "Hedge", note: `${hedge.swapCount}/${hedge.legs.length}` },
              { key: "CONTRARIAN", label: "Contrarian", note: `${contrarian.swapCount}/${contrarian.legs.length}` },
            ]}
          />
        )}
        {swap && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className={LABEL}>Swap:</span>
            <TextSegments label="Swap" options={SWAP_SCOPE_OPTIONS} value={swapScope} onChange={onSwapScope} />
          </div>
        )}
        {notes.length > 0 && (
          <div role="status" className="mt-3 rounded-[12px] border border-amber-300 bg-amber-50/60 px-3.5 py-2.5 dark:border-amber-800 dark:bg-amber-500/10">
            {notes.map((n) => (
              <p key={n} className="text-xs font-medium text-foreground">
                {n}
              </p>
            ))}
          </div>
        )}
        <div className="mt-1">
          {swap && (
            <p className="mt-2 text-xs font-medium text-muted-foreground">
              {swap.swapCount} of {swap.legs.length} legs {SWAP_COPY[swap.mode].verb}
            </p>
          )}
          <ol className={LEG_LIST}>
            {swap
              ? swap.legs.map((l, i) => <SwapLegRow key={l.original.pick.pickId} n={i + 1} leg={l} mode={swap.mode} />)
              : shownLegs.map((l, i) => (
                  <LegRow
                    key={l.pick.pickId}
                    n={i + 1}
                    pick={l.pick}
                    record={{ text: recordText(l.record, l.basis, l.pick, l.propMarket), winPct: l.record?.winPct ?? null }}
                    mine={l.source === "SLIP"}
                    sgp={l.sameGame}
                    arrive={arrive || landed === i}
                    handSwapped={l.handSwapped === true}
                    action={canSwap ? <SwapButton n={i + 1} open={trayIndex === i} trayId={"swap-tray-" + i} onClick={() => toggleTray(i)} /> : undefined}
                    overlay={swapping === i ? <SwapOverlay /> : undefined}
                  >
                    {trayIndex === i && alternatives && (
                      <SwapTray
                        id={"swap-tray-" + i}
                        n={i + 1}
                        matchup={l.gameLabel}
                        alternatives={alternatives}
                        tab={tray!.tab}
                        onTab={(t) => setTray({ index: i, tab: t })}
                        favoritesOnly={favoritesOnly}
                        onUse={(pickId) => chooseAlternative(i, pickId)}
                        onKeep={() => setTray(null)}
                      />
                    )}
                  </LegRow>
                ))}
            {Array.from({ length: placeholders }, (_, i) => (
              <PlaceholderLeg key={"placeholder-" + i} />
            ))}
          </ol>
          <div ref={oddsRef} className="scroll-mb-4">
            <CombinedPrice legs={shownPicks} sameGame={sameGame} tween={(arrive || swapTween) && !swap} />
          </div>
          {done && legs.length > 0 && (
            <div ref={bannerRef} data-parlay-complete className={COMPLETE_BANNER}>
              <p className="text-[10.5px] font-bold uppercase tracking-[0.07em] text-brand-700 dark:text-brand-300">Parlay complete</p>
              <p className="mt-0.5 text-xs font-medium text-foreground">{completeText(legs.length, done.requested)}</p>
              <SendToFanDuel legs={sendLegs(shownPicks)} onOpened={onSent} className="mt-2.5" />
            </div>
          )}
        </div>
      </PanelShell>
    </div>
  );
}
