"use client";

// The Parlay Generator's result: a navy banner ("Your parlay is ready", N legs ·
// N games · N leagues, Best / Diversified / Explore, Regenerate), the legs as
// cards strongest first, and a bottom bar (combined odds, $10 pays, Reset all,
// Send to FanDuel). Renders a GeneratedParlay (lib/parlay/generator.ts) as built -
// nothing is chosen here.
//
//   - Every leg shows its record as W-L (win %), so the sample size is in plain
//     sight. A slip pick says it's yours; a leg whose game has another leg is
//     tagged SGP.
//   - Combined odds only for a parlay with no same-game legs: legs on one game
//     aren't independent, and FanDuel prices them itself.
//   - Each leg has one action, Swap: a modal with Primary / Hedge / Contrarian /
//     Other games tabs (legSwapOptions, generator.ts) that replaces that one leg.
//   - Generate / Regenerate build the card pick by pick (use-build-reveal.ts):
//     an analyzing step, then the legs one at a time, strongest first, with the
//     combined price of the legs shown so far. Presentation only - every leg and
//     price is the engine's answer.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { PICK_CATEGORY_LABELS } from "@/server/data/stats";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { ClipboardIcon, ClockIcon, FlameIcon, ListChecksIcon, RefreshIcon } from "@/components/dashboard/cappers-icons";
import { LABEL } from "@/components/parlay/parlay-controls";
import { SendToFanDuel } from "@/components/parlay/send-to-fanduel";
import { combineOdds, decimalToAmerican, formatAmericanOdds, formatPayout, hasUsablePrice, payoutOn, type CombineLeg } from "@/lib/parlay/combine-odds";
import { ANALYZING_STATUS, easeOut, LAND_MS, ODDS_TWEEN_MS } from "@/lib/parlay/build-reveal";
import { prefersReducedMotion, type Reveal } from "@/components/parlay/use-build-reveal";
import { isGameLive, LIVE_NOTE, type GameClock } from "@/lib/parlay/game-over";
import { SWAP_TAB_KEYS, type EngineLeg, type GeneratedParlay, type LeagueSlice, type LegRecord, type LegSwapOptions, type SwapOption, type SwapTabKey } from "@/lib/parlay/generator";
import type { PropMarketKey } from "@/lib/prop-market-key";
import { SELECTION_MODES, type SelectionMode } from "@/lib/parlay/selection";
import { noAlternativeText, pickSummary, regenerateState, unusedLine, unusedPicks, type NoAlternativeReason } from "@/lib/parlay/subset-ui";
import {
  isHot,
  leagueChips,
  leagueTagClass,
  legRecordLabel,
  OTHER_GAMES_NOTE,
  strengthOrder,
  SWAP_EMPTY,
  SWAP_STAKE,
  SWAP_TAB_HELP,
  SWAP_TAB_LABELS,
  swapComparison,
  tabRows,
  winTier,
  type PriceView,
  type WinTier,
} from "@/lib/parlay/swap-modal";

export const formatOdds = (odds: number) => (odds > 0 ? "+" : "") + odds;
export const formatGameTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const plural = (n: number) => (n === 1 ? "" : "s");
const TAG = "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-bold";

// "50% (6–6) · Underdog spread · NFL 1–0": the capper's real record in the
// category across every league, the category, and the in-league slice
// (legRecordLabel, swap-modal.ts). A prop with a market key names its market.
// A slip pick with no category record: "· last 20 picks".
export function recordText(
  record: LegRecord | null,
  basis: EngineLeg["basis"],
  pick: Pick<ExpanderPick, "category" | "leagueName">,
  propMarket?: PropMarketKey,
  leagueSlice?: LeagueSlice
): string {
  return legRecordLabel(record, basis, pick, propMarket, leagueSlice);
}
const legRecordText = (l: EngineLeg) => recordText(l.record, l.basis, l.pick, l.propMarket, l.leagueSlice);

// ---- Win rate: the text and its bar, coloured by tier (swap-modal.ts) -------------
const TIER_TEXT: Record<WinTier, string> = {
  STRONG: "text-[#15803D] dark:text-[#4ADE80]",
  GOOD: "text-[#16A34A] dark:text-[#86EFAC]",
  LOW: "text-amber-700 dark:text-amber-400",
  NONE: "text-muted-foreground",
};
const TIER_BAR: Record<WinTier, string> = { STRONG: "bg-[#15803D]", GOOD: "bg-[#4ADE80]", LOW: "bg-amber-400", NONE: "" };

function WinRate({ leg, className = "" }: { leg: EngineLeg; className?: string }) {
  const pct = leg.record?.winPct ?? null;
  const tier = winTier(pct);
  return (
    <div data-win-tier={tier} className={"flex flex-wrap items-center gap-x-2.5 gap-y-1 " + className}>
      <p className={"text-[11.5px] font-semibold tabular-nums " + TIER_TEXT[tier]}>{legRecordText(leg)}</p>
      <div aria-hidden className="h-1 w-24 shrink-0 overflow-hidden rounded-md bg-[#E3E8F5] dark:bg-white/10">
        {pct !== null && <div className={"h-full rounded-md " + TIER_BAR[tier]} style={{ width: Math.min(100, Math.max(0, pct)) + "%" }} />}
      </div>
    </div>
  );
}

function LeagueTag({ league }: { league: string }) {
  return <span className={"rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.04em] " + leagueTagClass(league)}>{league}</span>;
}

// "NBA  Bulls @ Pacers  ⏱ 7:30 PM"
function GameLine({ pick, gameLabel, gameTime, children }: { pick: Pick<ExpanderPick, "leagueName">; gameLabel: string; gameTime: string; children?: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] font-medium text-muted-foreground">
      <LeagueTag league={pick.leagueName} />
      <span className="[overflow-wrap:anywhere]">{gameLabel}</span>
      <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
        <ClockIcon className="h-3 w-3" />
        {formatGameTime(gameTime)}
      </span>
      {children}
    </p>
  );
}

const capperLine = (pick: ExpanderPick) => (pick.category ? " · " + PICK_CATEGORY_LABELS[pick.category] : "");
const ODDS_PILL = "shrink-0 rounded-full bg-[#F1F3F7] px-2.5 py-1 text-[13px] font-semibold tabular-nums text-foreground dark:bg-white/10";

// ---- A leg's card -------------------------------------------------------------------
// A leg just swapped in, and a leg the build just added: a brand ring that fades.
const LIT = "ring-[1.5px] ring-brand-600 bg-brand-600/[0.04] dark:ring-brand-400 dark:bg-brand-400/[0.06]";
const UNLIT = "ring-[1.5px] ring-transparent";
const ARRIVE_MOTION = "animate-leg-land transition-[background-color,box-shadow] duration-[1900ms] ease-out motion-reduce:animate-none motion-reduce:transition-none";
const LEG_CARD =
  "group relative flex items-center gap-3 rounded-[14px] border border-[#E6E8EF] bg-white px-3.5 py-3 transition-[transform,box-shadow] duration-150 hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(15,20,32,0.08)] dark:border-border dark:bg-card";

function LegCard({ n, leg, arrive, action, overlay }: { n: number; leg: EngineLeg; arrive?: boolean; action?: ReactNode; overlay?: ReactNode }) {
  const { pick } = leg;
  const live = isGameLive(pick, new Date());
  // Lit from the moment it lands; the highlight starts fading once the slide-in is done.
  const [lit, setLit] = useState(Boolean(arrive));
  useEffect(() => {
    if (!arrive) return;
    const t = setTimeout(() => setLit(false), LAND_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the card lands
  }, []);
  const frame = arrive ? (lit ? LIT : UNLIT) + " " + ARRIVE_MOTION : "";
  const pct = leg.record?.winPct ?? null;
  return (
    <li data-leg className={LEG_CARD + " " + frame} aria-busy={overlay ? true : undefined}>
      {overlay}
      <span className="flex h-7 w-7 shrink-0 items-center justify-center self-start rounded-full bg-banner text-xs font-bold tabular-nums text-white">{n}</span>
      <div className="min-w-0 flex-1">
        <GameLine pick={pick} gameLabel={leg.gameLabel} gameTime={leg.gameTime}>
          {live && <span className={TAG + " bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"}>Live</span>}
          {leg.sameGame && <span className={TAG + " bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400"}>SGP</span>}
          {leg.source === "SLIP" && (
            <span className={TAG + " bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"} title="One of your picks - in every parlay">
              <ClipboardIcon className="h-3 w-3 stroke-[2.4]" />
              Your pick
            </span>
          )}
          {leg.handSwapped && (
            <span data-swapped-tag className={TAG + " bg-brand-600/10 text-brand-700 dark:bg-brand-400/15 dark:text-brand-300"}>
              Swapped
            </span>
          )}
          {isHot(pct) && (
            <span data-hot-tag className={TAG + " bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300"}>
              <FlameIcon className="h-3 w-3" />
              Hot
            </span>
          )}
        </GameLine>
        <p className="mt-0.5 text-[15px] font-bold leading-snug text-foreground [overflow-wrap:anywhere]">{pick.betDetail}</p>
        <p className="text-xs font-medium text-muted-foreground">
          <Link href={"/cappers/" + pick.capperId} className="text-foreground hover:underline">
            {pick.capperName}
          </Link>
          {capperLine(pick)}
        </p>
        <WinRate leg={leg} className="mt-1.5" />
        {live && <p className="mt-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">{LIVE_NOTE}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2 self-center sm:flex-row sm:items-center">
        <span className={ODDS_PILL}>{formatOdds(pick.odds)}</span>
        {action}
      </div>
    </li>
  );
}

// ---- Swap one leg by hand -------------------------------------------------------------
export const SWAP_OVERLAY_MS = 750;
export const SWAP_FINDING = "Finding another eligible pick…";
export const swappingStatus = (n: number) => `Re-scoring leg ${n} · ${SWAP_FINDING}`;
export const swappedStatus = (n: number) => `Leg ${n} swapped · Combined odds updated`;

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

// Light blue, solid blue on hover; an invisible 8px above and below makes the tap target 44px.
const SWAP_BUTTON =
  "relative inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-brand-600/10 px-3 py-1.5 text-xs font-semibold text-brand-700 transition hover:bg-brand-600 hover:text-white dark:bg-brand-400/15 dark:text-brand-300 dark:hover:bg-brand-400 dark:hover:text-[#0F1420] after:absolute after:inset-x-0 after:-inset-y-2 after:content-['']";

function SwapButton({ n, onClick }: { n: number; onClick: () => void }) {
  return (
    <button type="button" data-swap-button onClick={onClick} aria-haspopup="dialog" aria-label={`Swap leg ${n}`} className={SWAP_BUTTON}>
      <SwapArrowsIcon className="h-3 w-3" />
      Swap
    </button>
  );
}

function SwapOverlay() {
  return (
    <div data-swap-overlay className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-[14px] bg-white/90 dark:bg-card/90">
      <p className="text-xs font-semibold text-foreground">{SWAP_FINDING}</p>
      <div aria-hidden="true" className="relative h-1 w-28 overflow-hidden rounded-full bg-[#0F1420]/[0.07] dark:bg-white/10">
        <span className="absolute inset-y-0 left-0 w-1/2 animate-build-shimmer bg-gradient-to-r from-transparent via-brand-500 to-transparent" />
      </div>
    </div>
  );
}

// The tab colours: Primary blue, Hedge green, Contrarian orange, Other games violet.
const TAB_ON: Record<SwapTabKey, string> = {
  PRIMARY: "border-brand-600 bg-brand-600 text-white dark:border-brand-500 dark:bg-brand-500",
  HEDGE: "border-emerald-600 bg-emerald-600 text-white",
  CONTRARIAN: "border-orange-500 bg-orange-500 text-white",
  OTHER_GAMES: "border-violet-600 bg-violet-600 text-white",
};
const TAB_COUNT_OFF: Record<SwapTabKey, string> = {
  PRIMARY: "bg-brand-600/10 text-brand-700 dark:bg-brand-400/15 dark:text-brand-300",
  HEDGE: "bg-emerald-600/10 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  CONTRARIAN: "bg-orange-500/10 text-orange-700 dark:bg-orange-400/15 dark:text-orange-300",
  OTHER_GAMES: "bg-violet-600/10 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
};
const MODAL_BUTTON = "inline-flex min-h-[40px] items-center justify-center rounded-full px-4 text-[13px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45";

function PriceText({ view, tone }: { view: PriceView; tone?: string }) {
  if (view.kind === "FANDUEL") return <span className="font-semibold text-foreground">Priced at FanDuel</span>;
  if (view.kind === "UNAVAILABLE") return <span className="font-semibold text-foreground">Unavailable</span>;
  return <span className={"font-bold tabular-nums " + (tone ?? "text-foreground")}>{(view.estimated ? "≈ " : "") + formatAmericanOdds(view.american)}</span>;
}

export function SwapModal({
  n,
  leg,
  options,
  error,
  legs,
  index,
  onClose,
  onUpdate,
}: {
  n: number;
  leg: EngineLeg;
  // null with `error`: the options couldn't be worked out.
  options: LegSwapOptions | null;
  error: string | null;
  // Every leg of the parlay (the engine's order) and this one's index, for the combined price.
  legs: readonly EngineLeg[];
  index: number;
  onClose: () => void;
  onUpdate: (pickId: string) => void;
}) {
  const [tab, setTab] = useState<SwapTabKey>("PRIMARY");
  const [league, setLeague] = useState<string | null>(null);
  // The current pick, until another row is chosen.
  const [selected, setSelected] = useState<string>(leg.pick.pickId);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open
  }, []);

  const rows = options ? tabRows(options, tab, league) : [];
  const chosen: SwapOption | null = options && selected !== leg.pick.pickId ? (SWAP_TAB_KEYS.flatMap((t) => options[t]).find((o) => o.pick.pickId === selected) ?? null) : null;
  const priceLegs = legs.map((l) => ({ odds: l.pick.odds, oddsSource: l.pick.oddsSource ?? null, gameId: l.gameId }));
  const cmp = swapComparison(priceLegs, index, chosen ? { odds: chosen.pick.odds, oddsSource: chosen.pick.oddsSource ?? null, gameId: chosen.gameId } : null);
  const shown = cmp.next ?? cmp.now;
  const nextTone = cmp.direction === "UP" ? "text-[#15803D] dark:text-[#4ADE80]" : cmp.direction === "DOWN" ? "text-orange-600 dark:text-orange-400" : undefined;
  const titleId = "swap-leg-title-" + index;

  return (
    <div
      data-swap-modal-backdrop
      className="fixed inset-0 z-50 flex items-end justify-center bg-[#0F1420]/55 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-swap-modal
        className="flex max-h-[92vh] w-full max-w-[680px] flex-col overflow-hidden rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_24px_60px_rgba(3,11,41,0.35)] outline-none dark:bg-card sm:rounded-2xl sm:pb-0"
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-[#0F1420]/[0.07] px-5 pb-3.5 pt-4 dark:border-white/10">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-banner text-[13px] font-bold tabular-nums text-white">{n}</span>
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="text-[17px] font-bold leading-tight text-foreground">
              Swap Leg {n}
            </h3>
            <p className="text-xs font-medium text-muted-foreground">Choose an alternative pick for this leg.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xl leading-none text-muted-foreground transition hover:bg-muted hover:text-foreground">
            ×
          </button>
        </div>

        {/* Now */}
        <div data-swap-now className="mx-5 mt-3.5 flex items-center gap-3 rounded-xl bg-[#F4F5F8] px-3.5 py-2.5 dark:bg-white/[0.06]">
          <span className="shrink-0 rounded-full bg-banner px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-white">Now</span>
          <div className="min-w-0 flex-1">
            <GameLine pick={leg.pick} gameLabel={leg.gameLabel} gameTime={leg.gameTime} />
            <p className="text-sm font-bold leading-snug text-foreground [overflow-wrap:anywhere]">{leg.pick.betDetail}</p>
            <p className="text-[11.5px] font-medium text-muted-foreground">
              {leg.pick.capperName}
              {capperLine(leg.pick)}
            </p>
          </div>
          <span className={ODDS_PILL}>{formatOdds(leg.pick.odds)}</span>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3.5">
          <div role="tablist" aria-label={`Swap leg ${n} from`} className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {SWAP_TAB_KEYS.map((key) => {
              const on = key === tab;
              const count = options ? options[key].length : 0;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  data-swap-tab={key}
                  aria-selected={on}
                  onClick={() => {
                    setTab(key);
                    setLeague(null);
                  }}
                  className={
                    "flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border px-2 text-[13px] font-semibold transition " +
                    (on ? TAB_ON[key] : "border-[#DADDE5] bg-white text-foreground hover:bg-[#0F1420]/[0.03] dark:border-border dark:bg-card")
                  }
                >
                  {SWAP_TAB_LABELS[key]}
                  <span data-swap-count className={"rounded-full px-1.5 text-[11px] font-bold tabular-nums " + (on ? "bg-white/25 text-white" : TAB_COUNT_OFF[key])}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <p data-swap-subtitle className="mt-2 text-[11.5px] font-medium text-muted-foreground">
            {SWAP_TAB_HELP[tab]}
          </p>
          {tab === "OTHER_GAMES" && options && options.OTHER_GAMES.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {leagueChips(options.OTHER_GAMES).map((c) => {
                const on = c.league === league;
                return (
                  <button
                    key={c.league ?? "ALL"}
                    type="button"
                    data-league-chip={c.league ?? "ALL"}
                    aria-pressed={on}
                    onClick={() => setLeague(c.league)}
                    className={
                      "inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold transition " +
                      (on ? "border-violet-600 bg-violet-600 text-white" : "border-[#DADDE5] bg-white text-foreground hover:bg-[#0F1420]/[0.03] dark:border-border dark:bg-card")
                    }
                  >
                    {c.league ?? "All"}
                    <span className="tabular-nums opacity-75">{c.count}</span>
                  </button>
                );
              })}
              <span className="ml-auto text-[11px] font-medium text-muted-foreground">{OTHER_GAMES_NOTE}</span>
            </div>
          )}
        </div>

        {/* Rows */}
        <div className="mt-2.5 min-h-[120px] flex-1 overflow-y-auto border-t border-[#0F1420]/[0.07] px-5 py-2 dark:border-white/10">
          {error ? (
            <p data-swap-error className="py-6 text-center text-sm font-medium text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : !options ? (
            <p data-swap-loading className="py-6 text-center text-sm font-medium text-muted-foreground">
              Loading alternatives…
            </p>
          ) : rows.length === 0 ? (
            <p data-swap-empty className="py-6 text-center text-sm font-medium text-muted-foreground">
              {SWAP_EMPTY[tab]}
            </p>
          ) : (
            <ul role="radiogroup" aria-label={SWAP_TAB_LABELS[tab]} className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
              {rows.map((o) => {
                const id = o.pick.pickId;
                const on = selected === id;
                return (
                  <li key={id}>
                    <label
                      data-swap-option={id}
                      className={"flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 transition " + (on ? "bg-brand-600/[0.06] dark:bg-brand-400/[0.08]" : "hover:bg-[#0F1420]/[0.025] dark:hover:bg-white/[0.04]")}
                    >
                      <input type="radio" name={"swap-leg-" + index} value={id} checked={on} onChange={() => setSelected(id)} className="h-4 w-4 shrink-0 accent-brand-600" />
                      <div className="min-w-0 flex-1">
                        {tab === "OTHER_GAMES" && <GameLine pick={o.pick} gameLabel={o.gameLabel} gameTime={o.gameTime} />}
                        <p className="flex flex-wrap items-center gap-1.5 text-sm font-bold leading-snug text-foreground [overflow-wrap:anywhere]">
                          {o.pick.betDetail}
                          {o.current && (
                            <span data-current-badge className={TAG + " bg-banner text-white"}>
                              Current
                            </span>
                          )}
                        </p>
                        <p className="text-[11.5px] font-medium text-muted-foreground">
                          {o.pick.capperIsFavorite && (
                            <span className="mr-0.5 text-[#f59e0b]" aria-label="Favorite capper">
                              ★
                            </span>
                          )}
                          {o.pick.capperName}
                          {capperLine(o.pick)}
                        </p>
                        {o.note && <p className="text-[11.5px] font-semibold text-[#15803D] dark:text-[#4ADE80]">{o.note}</p>}
                        <WinRate leg={o} className="mt-1" />
                      </div>
                      <span className={ODDS_PILL}>{formatOdds(o.pick.odds)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-t border-[#0F1420]/[0.07] px-5 py-3.5 dark:border-white/10">
          <div data-swap-footer className="min-w-0 text-[13px] font-medium text-muted-foreground">
            <p>
              <span className="mr-2">Combined odds</span>
              <PriceText view={cmp.now} />
              {cmp.next && (
                <>
                  <span className="mx-1.5">→</span>
                  <PriceText view={cmp.next} tone={nextTone} />
                </>
              )}
            </p>
            {shown.kind === "PRICED" && (
              <p className="text-xs">
                ${SWAP_STAKE} pays <span className="font-semibold text-foreground">{(shown.estimated ? "≈ " : "") + formatPayout(shown.payout)}</span>
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={MODAL_BUTTON + " border border-[#DADDE5] bg-white text-foreground hover:bg-[#0F1420]/[0.03] dark:border-border dark:bg-card"}>
              Cancel
            </button>
            <button type="button" disabled={!chosen} onClick={() => chosen && onUpdate(chosen.pick.pickId)} className={MODAL_BUTTON + " bg-brand-600 text-white hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-400"}>
              Update Leg
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- The combined price ---------------------------------------------------------------
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

const PRICE_LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground";

// The bottom bar's price: "Combined odds +595 · $10 pays $69.50", or why there's no number.
export function CombinedPrice({ legs, sameGame, tween = false }: { legs: (CombineLeg & Partial<GameClock>)[]; sameGame: boolean; tween?: boolean }) {
  const combined = combineOdds(legs);
  const shownDecimal = useTweenedDecimal(!sameGame && combined.status === "AVAILABLE" ? combined.decimal : null, tween);
  // A leg on a game under way is priced as posted; its odds may have moved.
  const now = new Date();
  const isLive = (l: CombineLeg & Partial<GameClock>) => l.gameTime !== undefined && isGameLive({ gameTime: l.gameTime, gameStatus: l.gameStatus, gameId: l.gameId }, now);
  const liveNote = legs.some(isLive) ? <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">{LIVE_NOTE}</p> : null;
  if (sameGame) {
    return (
      <div className="min-w-0">
        <p className={PRICE_LABEL}>Combined odds</p>
        <p className="text-sm font-semibold text-foreground">Priced at FanDuel</p>
        <p className="text-xs font-medium text-muted-foreground">Same-game legs aren&apos;t independent, so FanDuel prices this parlay itself.</p>
        {liveNote}
      </div>
    );
  }
  if (combined.legCount === 0) return null;
  if (combined.status === "UNAVAILABLE") {
    return (
      <div className="min-w-0">
        <p className={PRICE_LABEL}>Combined odds</p>
        <p className="text-sm font-semibold text-foreground">Unavailable</p>
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
    <div className="min-w-0">
      <dl className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <dt className={PRICE_LABEL}>{(combined.estimated ? "Combined odds (estimate)" : "Combined odds") + asPosted}</dt>
        <dd className="text-[17px] font-bold tabular-nums leading-snug text-foreground">{approx + formatAmericanOdds(price.american)}</dd>
        <dt aria-hidden className="text-muted-foreground">
          ·
        </dt>
        <dd className="text-[13px] font-medium text-muted-foreground">
          ${SWAP_STAKE} pays <span className="font-semibold tabular-nums text-foreground">{approx + formatPayout(payoutOn(price, SWAP_STAKE))}</span>
        </dd>
      </dl>
      {combined.estimated && (
        <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
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

// ---- The banner -----------------------------------------------------------------------
// Regenerate on navy: a white outline pill with an invisible 10px above and below (a 44px target).
const REGENERATE =
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border border-white/35 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-white/20 disabled:opacity-50 after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-['']";

export const MODE_LABELS: Record<SelectionMode, string> = { BEST: "Best", DIVERSIFIED: "Diversified", EXPLORE: "Explore" };
// One line under the banner per mode; Regenerate only (Generate stays the same parlay).
export const MODE_HELP: Record<SelectionMode, string> = {
  BEST: "Strongest legs first. Regenerates stay close to your top parlay. Applies on your next Regenerate.",
  DIVERSIFIED: "Mostly strong legs, with variety. Recently used legs are less likely to repeat. Applies on your next Regenerate.",
  EXPLORE: "Wider mix. Gives more legs a chance, including lower-ranked ones. Applies on your next Regenerate.",
};
export const LIMITED_TITLE = (have: number, need: number) => `Only ${have} of ${need} legs clear your bar right now.`;
export const LIMITED_BODY = "Lower Minimum Capper Win Rate, widen Bet Types, or switch on more leagues to add legs. Your bar stays where you set it.";

// The banner's mode picker: a segmented control on navy, 26px tall with a 44px tap target.
function ModePicker({ value, onChange, disabled }: { value: SelectionMode; onChange: (m: SelectionMode) => void; disabled: boolean }) {
  return (
    <div role="radiogroup" aria-label="Regenerate mode" className="flex shrink-0 items-center gap-0.5 rounded-full border border-white/25 bg-white/10 p-0.5">
      {SELECTION_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={m === value}
          disabled={disabled}
          onClick={() => onChange(m)}
          className={
            "relative flex h-[22px] flex-1 items-center justify-center whitespace-nowrap rounded-full px-2 text-xs font-semibold transition disabled:opacity-50 sm:flex-none after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] " +
            (m === value ? "bg-white text-banner" : "text-white/80 hover:text-white")
          }
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

const sendLegs = (picks: ExpanderPick[]) => picks.map((p) => ({ pickId: p.pickId, betDetail: p.betDetail, gameId: p.gameId, gameLabel: p.gameLabel }));

// The build's progress, on navy: the scan line (while building), the bar (revealed / total).
function BuildProgress({ revealed, total, active }: { revealed: number; total: number; active: boolean }) {
  const pct = total > 0 ? Math.round((Math.min(revealed, total) / total) * 100) : 0;
  return (
    <div data-build-progress className="mt-3">
      {active && (
        <div aria-hidden="true" className="relative mb-1.5 h-0.5 overflow-hidden rounded-full">
          <span className="absolute inset-y-0 left-0 w-1/3 animate-build-scan bg-gradient-to-r from-transparent via-[#38BDF8] to-transparent motion-reduce:hidden" />
        </div>
      )}
      <div role="progressbar" aria-label="Parlay build progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={revealed} className="h-1.5 overflow-hidden rounded-full bg-white/15">
        <div className="h-full rounded-full bg-[#38BDF8] transition-[width] duration-500 ease-out motion-reduce:transition-none" style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}

// The banner's status line: the build's step, then "Leg N swapped · Combined odds updated".
function BannerStatus({ text, active }: { text: string; active: boolean }) {
  return (
    <p role="status" aria-live="polite" data-swap-status className="mt-2.5 flex items-center gap-2 text-xs font-medium text-[#BFD3FF]">
      <span aria-hidden="true" className={"h-2 w-2 shrink-0 rounded-full bg-[#38BDF8] " + (active ? "animate-pulse motion-reduce:animate-none" : "")} />
      {text}
    </p>
  );
}

// A leg still to come: the card's shape, shimmering.
function PlaceholderLeg() {
  const bar = "rounded-full bg-[#0F1420]/[0.07] dark:bg-white/10";
  return (
    <li aria-hidden="true" data-placeholder-leg className="relative flex gap-3 overflow-hidden rounded-[14px] border border-[#E6E8EF] bg-white px-3.5 py-3 dark:border-border dark:bg-card">
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

function ReadyCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-[17px] w-[17px]">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

const BUILDING_TITLE = "Building your parlay";
export const READY_TITLE = "Your parlay is ready";
const scrollNearest = (el: HTMLElement | null) => el?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
export const LEGS_HEADING = "Legs · strongest first";
export const LEGS_HINT = "Swap any leg for Primary, Hedge, Contrarian or Other-game picks";

export function GeneratorResult({
  parlay,
  reveal,
  requestedLegs,
  favoritesOnly = false,
  busy,
  noAlternative,
  unavailableTargetLabels,
  onRegenerate,
  selectionMode,
  onSelectionMode,
  onSent,
  legSwap,
  onResetAll,
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
  // Swapping one leg by hand (the card's session, on its snapshot): a leg's swap
  // options, and replacing it with one - false when it no longer can.
  // Absent: no Swap buttons.
  legSwap?: {
    options: (legIndex: number) => LegSwapOptions;
    apply: (legIndex: number, pickId: string) => boolean;
  };
  // Put every swapped leg back (the parlay as built). Absent: no Reset all.
  onResetAll?: () => void;
}) {
  // The leg whose Swap modal is open (the engine's index).
  const [modal, setModal] = useState<number | null>(null);
  // The leg under the "Finding another eligible pick…" overlay.
  const [swapping, setSwapping] = useState<number | null>(null);
  const [swapStatus, setSwapStatus] = useState<string | null>(null);
  // The leg a hand swap just replaced: its new card lands with the build's highlight.
  const [landed, setLanded] = useState<number | null>(null);
  // Combined odds ease to the new price after an animated swap.
  const [swapTween, setSwapTween] = useState(false);
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A parlay the card sent for another reason than this card's swap (a rebuild, Reset all) clears the swap state.
  const ownSwap = useRef(false);
  useEffect(() => {
    if (ownSwap.current) {
      ownSwap.current = false;
      return;
    }
    if (swapTimer.current) clearTimeout(swapTimer.current);
    setModal(null);
    setSwapping(null);
    setSwapStatus(null);
    setLanded(null);
    setSwapTween(false);
  }, [parlay]);
  useEffect(() => () => void (swapTimer.current && clearTimeout(swapTimer.current)), []);
  const cardRef = useRef<HTMLElement>(null);
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

  // One tree for every phase, each part in a fixed place: the cards a build has landed
  // stay mounted when it completes (no second landing).
  const analyzing = !parlay || phase === "analyzing";
  const building = analyzing || phase === "building";
  const done = !building ? parlay : null;
  const legs = parlay?.legs ?? [];
  // Strongest first, worked out once per build: a hand swap or Reset all keeps every card in its place.
  const orderRef = useRef<{ key: string; order: number[] } | null>(null);
  const orderKey = parlay ? parlay.generatedKey + ":" + legs.length : "";
  if (parlay && orderRef.current?.key !== orderKey) orderRef.current = { key: orderKey, order: strengthOrder(legs) };
  const order = parlay ? orderRef.current!.order : [];
  const total = analyzing ? (reveal?.total ?? requestedLegs) : legs.length;
  const shownOrder = analyzing ? [] : building ? order.slice(0, revealed) : order;
  const shownLegs = shownOrder.map((i) => legs[i]);
  // While building: Priced at FanDuel as soon as two shown legs share a game, as the full card would be.
  const gameIds = shownLegs.map((l) => l.gameId);
  const sameGame = done ? done.sameGameGames > 0 : new Set(gameIds).size < gameIds.length;
  const shownPicks = shownLegs.map((l) => l.pick);
  const regenerate = done ? regenerateState(done, noAlternative) : null;
  const canSwap = Boolean(legSwap) && done !== null && swapping === null && !busy;
  const modalIndex = canSwap && modal !== null && modal < legs.length ? modal : null;
  const modalData = useMemo((): { options: LegSwapOptions | null; error: string | null } | null => {
    if (modalIndex === null || !legSwap) return null;
    try {
      return { options: legSwap.options(modalIndex), error: null };
    } catch {
      return { options: null, error: "Couldn't load alternatives for this leg - close and try again." };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the legs on screen and the leg open
  }, [modalIndex, parlay]);
  const chooseAlternative = (index: number, pickId: string) => {
    setModal(null);
    const n = order.indexOf(index) + 1;
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
  const arrive = reveal !== null;
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
  const leagues = new Set(legs.map((l) => l.pick.leagueName)).size;
  const status = building ? (reveal?.status || ANALYZING_STATUS) : (swapStatus ?? (reveal ? `${total} of ${total} selections added` : null));
  const anySwapped = legs.some((l) => l.handSwapped);
  const modalLeg = modalIndex !== null ? legs[modalIndex] : null;

  return (
    <section ref={cardRef} className="scroll-mt-4" aria-busy={busy || undefined}>
      {/* The navy banner */}
      <div className="relative overflow-hidden rounded-2xl bg-banner px-4 py-3.5 text-white shadow-[0_10px_28px_rgba(3,11,41,0.28)] sm:rounded-[20px] sm:px-5">
        {/* Phones: stacked - title, meta line, then the mode picker and Regenerate. sm and up: one row. */}
        <div className="flex flex-col gap-y-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
          <div className="flex min-w-0 items-center gap-3 sm:flex-1">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-[#3B82F6] bg-[rgba(3,11,41,0.6)] text-[#9AD8FF] shadow-[0_0_12px_rgba(59,130,246,0.6)]">
              {building ? <ListChecksIcon className="h-[17px] w-[17px] stroke-[2.2]" /> : <ReadyCheck />}
            </span>
            <div className="min-w-0">
              <h2 className="text-[17px] font-extrabold leading-tight text-white">
                {building ? BUILDING_TITLE : READY_TITLE}
                {favoritesOnly && (
                  <span data-favorites-pill className="ml-2 inline-flex items-center gap-0.5 rounded-full border border-[#f5c451] bg-[#fff7e0] px-2 py-px align-middle text-[11px] font-semibold text-[#b45309]">
                    ★ Favorites
                  </span>
                )}
              </h2>
              <p className="mt-0.5 text-xs font-medium text-[#BFD3FF]">
                {analyzing ? (
                  "Checking eligible picks against your filters"
                ) : building ? (
                  <span className="rounded-full bg-white/10 px-2 py-px tabular-nums text-white">{`${revealed} / ${total}`}</span>
                ) : (
                  <>
                    {/* Each item unbroken: a narrow line wraps between items, never inside one. */}
                    <span className="whitespace-nowrap">{`${legs.length} legs`}</span>
                    {" · "}
                    <span className="whitespace-nowrap">{`${done!.gamesUsed} game${plural(done!.gamesUsed)}`}</span>
                    {" · "}
                    <span className="whitespace-nowrap">{`${leagues} league${plural(leagues)}`}</span>
                  </>
                )}
                {analyzing && <span className="sr-only">{`0 / ${total}`}</span>}
              </p>
            </div>
          </div>
          {regenerate && (
            // Phones: the picker full width, Regenerate full width under it (side by side doesn't fit at 360px). sm and up: as before.
            <div className="flex flex-col gap-3 sm:ml-auto sm:shrink-0 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:gap-x-2 sm:gap-y-1.5">
              <ModePicker value={selectionMode} onChange={onSelectionMode} disabled={busy} />
              <button type="button" onClick={onRegenerate} disabled={busy || regenerate.disabled} title={regenerate.hint} aria-label={"Regenerate: " + regenerate.hint} className={REGENERATE}>
                <RefreshIcon className="h-3.5 w-3.5 stroke-[2.4]" />
                {busy ? "Regenerating…" : "Regenerate"}
              </button>
            </div>
          )}
        </div>
        {reveal && <BuildProgress revealed={analyzing ? 0 : building ? revealed : total} total={total} active={building || swapping !== null} />}
        {status && <BannerStatus text={status} active={building || swapping !== null} />}
      </div>

      {done && <p className="mt-2.5 text-xs font-medium text-muted-foreground">{pickSummary(done)} · {MODE_HELP[selectionMode]}</p>}
      {done?.limited && (
        <div role="status" data-limited className="mt-2.5 rounded-[12px] border border-amber-300 bg-amber-50/60 px-3.5 py-2.5 dark:border-amber-800 dark:bg-amber-500/10">
          <p className="text-xs font-semibold text-foreground">{LIMITED_TITLE(done.limited.have, done.limited.need)}</p>
          <p className="mt-0.5 text-xs font-medium text-muted-foreground">{LIMITED_BODY}</p>
        </div>
      )}
      {done && noAlternative && (
        <p role="status" className="mt-2 text-xs font-medium text-muted-foreground">
          {noAlternativeText(noAlternative)}
        </p>
      )}
      {done && (
        <div className="mt-2">
          <UnusedPicks picks={unusedPicks(done)} />
        </div>
      )}
      {notes.length > 0 && (
        <div role="status" className="mt-2.5 rounded-[12px] border border-amber-300 bg-amber-50/60 px-3.5 py-2.5 dark:border-amber-800 dark:bg-amber-500/10">
          {notes.map((n) => (
            <p key={n} className="text-xs font-medium text-foreground">
              {n}
            </p>
          ))}
        </div>
      )}

      <div className="mt-3.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className={LABEL}>{LEGS_HEADING}</p>
        {legSwap && <p className="text-[11.5px] font-medium text-muted-foreground">{LEGS_HINT}</p>}
      </div>
      <ol className="mt-2 space-y-2">
        {shownOrder.map((engineIndex, pos) => {
          const l = legs[engineIndex];
          return (
            <LegCard
              key={l.pick.pickId}
              n={pos + 1}
              leg={l}
              arrive={arrive || landed === engineIndex}
              action={canSwap ? <SwapButton n={pos + 1} onClick={() => setModal(engineIndex)} /> : undefined}
              overlay={swapping === engineIndex ? <SwapOverlay /> : undefined}
            />
          );
        })}
        {Array.from({ length: placeholders }, (_, i) => (
          <PlaceholderLeg key={"placeholder-" + i} />
        ))}
      </ol>

      {/* The bottom bar */}
      <div
        ref={bannerRef}
        data-parlay-complete={done && legs.length > 0 ? true : undefined}
        className="mt-3 flex scroll-mb-4 flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-[14px] border border-[#E6E8EF] bg-white px-4 py-3 dark:border-border dark:bg-card"
      >
        <div ref={oddsRef} className="min-w-0 flex-1 scroll-mb-4">
          <CombinedPrice legs={shownPicks} sameGame={sameGame} tween={arrive || swapTween} />
        </div>
        {done && legs.length > 0 && (
          <div className="flex flex-wrap items-start justify-end gap-2">
            {onResetAll && (
              <button
                type="button"
                onClick={onResetAll}
                disabled={!anySwapped || swapping !== null}
                className="inline-flex h-10 items-center rounded-full border border-[#DADDE5] bg-white px-4 text-[13px] font-semibold text-foreground transition hover:bg-[#0F1420]/[0.03] disabled:cursor-not-allowed disabled:opacity-45 dark:border-border dark:bg-card"
              >
                Reset all
              </button>
            )}
            <SendToFanDuel legs={sendLegs(legs.map((l) => l.pick))} onOpened={onSent} />
          </div>
        )}
      </div>

      {modalLeg && modalData && (
        <SwapModal
          key={modalIndex! + ":" + modalLeg.pick.pickId}
          n={order.indexOf(modalIndex!) + 1}
          leg={modalLeg}
          options={modalData.options}
          error={modalData.error}
          legs={legs}
          index={modalIndex!}
          onClose={() => setModal(null)}
          onUpdate={(pickId) => chooseAlternative(modalIndex!, pickId)}
        />
      )}
    </section>
  );
}
