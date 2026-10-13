"use client";

// The Parlay Generator's shared result rendering: one row per leg, and the
// Hedge/Contrarian swap result built from the same SwapParlay shape
// (lib/parlay/auto-generate.ts) - so Auto-Generate and the pool-driven
// Select-Your-Own-Picks flow (parlay-pool-section.tsx) render an identical
// result, whichever primary pool produced it.
import type { ReactNode } from "react";
import Link from "next/link";
import { getRecordColor, PICK_CATEGORY_LABELS, PICK_CATEGORY_MARKET_NOUN, type PickCategoryKey } from "@/server/data/stats";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { GREEN, MUTED, RED } from "@/components/dashboard/stat-card";
import { TINTS } from "@/components/dashboard/panel-shell";
import { WIN_PCT_TRACK, WinPctBar } from "@/components/dashboard/category-card";
import { LABEL } from "@/components/parlay/parlay-controls";
import { SendToFanDuel, type SendLeg } from "@/components/parlay/send-to-fanduel";
import { rankBasisLabel, swapRecordLabel } from "@/lib/parlay/pick-record";
import { combineOdds, formatAmericanOdds, formatDecimalOdds, formatPayout, payoutOn, type CombineLeg } from "@/lib/parlay/combine-odds";
import type { RankedPick, SwapLeg, SwapParlay } from "@/lib/parlay/auto-generate";

export function marketNoun(category: PickCategoryKey | null): string {
  return category ? PICK_CATEGORY_MARKET_NOUN[category] : "this market";
}

export function formatGameTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export const formatOdds = (odds: number) => (odds > 0 ? "+" : "") + odds;

// The exact record a leg was ranked on, always shown - including a thin
// sample, and including when the capper has no history at all. The basis
// suffix (rankBasisLabel) is what keeps this readable next to a Hedge/
// Contrarian swap's record, which is always all-leagues-only - without it
// the two look directly comparable when they aren't (see pick-record.ts).
export function rankedRecordText({ record, pick }: Pick<RankedPick, "record"> & { pick: Pick<ExpanderPick, "leagueName" | "category"> }): string {
  return record
    ? rankBasisLabel(record, { leagueName: pick.leagueName, marketNoun: marketNoun(pick.category) })
    : "No record yet - ranked last";
}

export const LEG_LIST = "divide-y divide-[#0F1420]/[0.06] dark:divide-white/10";

// One leg: its number, the game, the pick, who made it in which market, the
// record it was chosen on (with a bar of its win %) and the odds. `winPct` is
// null when there is no record to draw. `children` is anything more the leg
// has to say (why a swap left it unchanged, its game's next picks). `tag` is a
// small badge beside the game ("SGP" on a leg whose game has another leg).
export function LegRow({
  n,
  pick,
  recordText,
  winPct,
  tag,
  children,
}: {
  n: number;
  pick: ExpanderPick;
  recordText: string;
  winPct: number | null;
  tag?: string;
  children?: ReactNode;
}) {
  const tone = winPct === null ? MUTED : getRecordColor(winPct) === "green" ? GREEN : RED;
  return (
    <li className="flex gap-3 py-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-banner text-xs font-bold tabular-nums text-white">{n}</span>
      <div className="min-w-0 flex-1">
        <p className={LABEL}>
          {pick.leagueName} · {pick.gameLabel} · {formatGameTime(pick.gameTime)}
          {tag && (
            <span className="ml-1.5 rounded-full bg-[#E6ECFF] px-1.5 py-px text-[10px] font-bold text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
              {tag}
            </span>
          )}
        </p>
        <div className="mt-0.5 flex items-baseline justify-between gap-3">
          <p className="min-w-0 text-[15px] font-bold leading-snug text-foreground [overflow-wrap:anywhere]">{pick.betDetail}</p>
          <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{formatOdds(pick.odds)}</p>
        </div>
        <p className="text-xs font-medium text-muted-foreground">
          <Link href={"/cappers/" + pick.capperId} className="text-foreground hover:underline">
            {pick.capperName}
          </Link>
          {pick.category && " · " + PICK_CATEGORY_LABELS[pick.category]}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <p className={"text-[11.5px] font-semibold tabular-nums " + tone}>{recordText}</p>
          <WinPctBar winPct={winPct ?? 0} decided={winPct !== null} className={"w-24 " + WIN_PCT_TRACK} />
        </div>
        {children}
      </div>
    </li>
  );
}

const SWAP_COPY = {
  AUTO_HEDGE: { title: "Hedge", verb: "hedged", noAlternate: "no other bet on this game clears 55% in its market" },
  CONTRARIAN: { title: "Contrarian", verb: "flipped", noAlternate: "no capper on the other side clears 55% in this market" },
} as const;

export function swapTitle(parlay: SwapParlay): string {
  return `${SWAP_COPY[parlay.mode].title} — ${parlay.legs.length}-leg parlay`;
}
export function swapSubtitle(parlay: SwapParlay): string {
  return `${parlay.swapCount} of ${parlay.legs.length} legs ${SWAP_COPY[parlay.mode].verb}`;
}

const NOTE = "mt-1.5 text-[11.5px] font-medium text-muted-foreground";

function SwapLegRow({ n, leg, mode }: { n: number; leg: SwapLeg; mode: SwapParlay["mode"] }) {
  if (!leg.swap) {
    const reason =
      leg.unchangedReason === "NOT_MAJORITY" ? "your pick's side isn't the majority of your cappers" : SWAP_COPY[mode].noAlternate;
    return (
      <LegRow n={n} pick={leg.original.pick} recordText={rankedRecordText(leg.original)} winPct={leg.original.record?.winPct ?? null}>
        <p className={NOTE}>
          <span className="rounded-full bg-muted px-1.5 py-0.5 font-semibold">Unchanged</span> {reason}
        </p>
      </LegRow>
    );
  }
  const { swap, original } = leg;
  return (
    <LegRow n={n} pick={swap.pick} recordText={swapRecordLabel(swap.record, marketNoun(swap.pick.category))} winPct={swap.record.winPct}>
      <p className={NOTE}>
        Replaces <span className="line-through">{original.pick.betDetail}</span> · {original.pick.capperName}
      </p>
    </LegRow>
  );
}

export function SwapLegs({ parlay }: { parlay: SwapParlay }) {
  return (
    <ol className={LEG_LIST}>
      {parlay.legs.map((leg, i) => (
        // Keyed by the primary's own pickId, not gameId - Auto-Generate's
        // parlayA has one leg per game so either would be unique, but the
        // pool-driven primary can have two legs from the same game (a
        // side + a total, say), so gameId alone would collide.
        <SwapLegRow key={leg.original.pick.pickId} n={i + 1} leg={leg} mode={parlay.mode} />
      ))}
    </ol>
  );
}

const plural = (n: number) => (n === 1 ? "" : "s");

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

// The price of the parlay as built: combined American and decimal odds, and
// what a $1 stake returns (lib/parlay/combine-odds.ts - display only, rounded
// here and nowhere earlier). Two honest exceptions, both said in words:
//   - a leg with no price at all: there is no number, so "unavailable" is
//     shown instead of one;
//   - a leg priced at the importer's -110 placeholder: the numbers are shown,
//     each marked "≈", with how many legs are placeholders.
// And one more when `sameGame` is set (the parlay has two or more legs on one
// game): the same math, marked "Est." and "≈", because legs on one game are not
// independent and a sportsbook prices them together, lower.
export function CombinedPrice({ legs, sameGame }: { legs: CombineLeg[]; sameGame?: boolean }) {
  const combined = combineOdds(legs);
  if (combined.legCount === 0) return null;
  const box = "mt-2.5 rounded-[12px] border border-[#E6E8EF] bg-white px-3.5 py-2.5 dark:border-border dark:bg-card";
  if (combined.status === "UNAVAILABLE") {
    return (
      <div className={box}>
        <p className={LABEL}>Combined odds</p>
        <p className="mt-0.5 text-sm font-semibold text-foreground">Unavailable</p>
        <p className="text-xs font-medium text-muted-foreground">
          {combined.unavailableLegs > 0
            ? `${combined.unavailableLegs} leg${plural(combined.unavailableLegs)} ${combined.unavailableLegs === 1 ? "has" : "have"} no price, so this parlay can't be priced.`
            : "This parlay's price is too large to show."}
        </p>
      </div>
    );
  }
  const approx = combined.estimated || sameGame ? "≈ " : "";
  const label = sameGame ? "Est. combined odds" : combined.estimated ? "Combined odds (estimate)" : "Combined odds";
  return (
    <div className={box}>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
        <PriceCell label={label} value={approx + formatAmericanOdds(combined.american)} />
        <PriceCell label="Decimal" value={approx + formatDecimalOdds(combined.decimal)} />
        <PriceCell label="Payout" value={approx + formatPayout(payoutOn(combined))} sub="on $1" />
      </dl>
      {sameGame && (
        <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
          Estimate: sportsbooks price same-game parlays lower than independent legs.
        </p>
      )}
      {combined.estimated && (
        <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
          Estimate: {combined.defaultedLegs} of {combined.legCount} leg{plural(combined.legCount)} had no posted price and{" "}
          {combined.defaultedLegs === 1 ? "is" : "are"} counted at a placeholder -110.
        </p>
      )}
    </div>
  );
}

// The legs a swap parlay actually plays: each leg's swap, or its original
// pick where nothing replaced it.
export function swapPriceLegs(parlay: SwapParlay): ExpanderPick[] {
  return parlay.legs.map((l) => (l.swap ?? l.original).pick);
}

// A built parlay: its name, a line about it, its combined price (when
// `priceLegs` is given), then its legs, then "Send to FanDuel" for the legs in
// `sendLegs`. `sameGamePrice` marks the price an estimate (see CombinedPrice).
// `plain` is for a
// result that already has a card of its own; otherwise it is a tinted block
// inside the card that built it.
export function ResultBlock({
  title,
  subtitle,
  plain,
  priceLegs,
  sameGamePrice,
  sendLegs,
  children,
}: {
  title: string;
  subtitle?: string;
  plain?: boolean;
  priceLegs?: CombineLeg[];
  sameGamePrice?: boolean;
  sendLegs?: SendLeg[];
  children: ReactNode;
}) {
  return (
    <div className={plain ? "" : "mt-4 rounded-[14px] border px-3.5 pb-1 pt-3 " + TINTS.blue.card}>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {subtitle && <p className={"text-xs font-medium " + TINTS.blue.subtitleClass}>{subtitle}</p>}
      {priceLegs && <CombinedPrice legs={priceLegs} sameGame={sameGamePrice} />}
      {children}
      {sendLegs && <SendToFanDuel legs={sendLegs} />}
    </div>
  );
}

export function SwapBlock({ parlay, plain }: { parlay: SwapParlay; plain?: boolean }) {
  return (
    <ResultBlock title={swapTitle(parlay)} subtitle={swapSubtitle(parlay)} plain={plain} priceLegs={swapPriceLegs(parlay)} sendLegs={swapPriceLegs(parlay)}>
      <SwapLegs parlay={parlay} />
    </ResultBlock>
  );
}
