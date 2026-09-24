"use client";

// Shared Hedge/Contrarian swap-result rendering, extracted from
// auto-generate-section.tsx so Auto-Generate and the pool-driven
// Select-Your-Own-Picks flow (parlay-pool-section.tsx) render an identical
// result from the same SwapParlay shape (lib/parlay/auto-generate.ts) -
// one UI, whichever primary pool produced it.
import type { CapperLeagueRecords } from "@/server/data/picks";
import { PICK_CATEGORY_MARKET_NOUN, type PickCategoryKey } from "@/server/data/stats";
import { PickCard } from "@/components/live/pick-card";
import { swapRecordLabel } from "@/lib/parlay/pick-record";
import type { SwapLeg, SwapParlay } from "@/lib/parlay/auto-generate";

export function marketNoun(category: PickCategoryKey | null): string {
  return category ? PICK_CATEGORY_MARKET_NOUN[category] : "this market";
}

export function formatGameTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function GameHeader({ label, time }: { label: string; time?: string }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {label}
      {time ? " · " + formatGameTime(time) : ""}
    </p>
  );
}

const SWAP_COPY = {
  AUTO_HEDGE: { title: "Hedge", verb: "hedged", noAlternate: "no other bet on this game clears 55% in its market" },
  CONTRARIAN: { title: "Contrarian", verb: "flipped", noAlternate: "no capper on the other side clears 55% in this market" },
} as const;

export function SwapLegView({ leg, mode, records }: { leg: SwapLeg; mode: SwapParlay["mode"]; records: CapperLeagueRecords }) {
  const copy = SWAP_COPY[mode];
  if (!leg.swap) {
    const reason =
      leg.unchangedReason === "NOT_MAJORITY" ? "your pick's side isn't the majority of your cappers" : copy.noAlternate;
    return (
      <div className="space-y-1">
        <GameHeader label={leg.gameLabel} />
        <p className="pl-1 text-[11px]">
          <span className="rounded-full bg-muted px-1.5 py-0.5 font-semibold text-muted-foreground">Unchanged</span>{" "}
          <span className="text-muted-foreground">{reason}</span>
        </p>
        <PickCard pick={leg.original.pick} records={records} loading={false} />
      </div>
    );
  }
  const { swap } = leg;
  return (
    <div className="space-y-1">
      <GameHeader label={leg.gameLabel} />
      <p className="pl-1 text-[11px] text-foreground">
        <span className="text-muted-foreground line-through">{leg.original.pick.betDetail}</span> &rarr;{" "}
        <span className="font-semibold">{swap.pick.betDetail}</span> &middot; {swap.pick.capperName}{" "}
        <span className="font-semibold">{swapRecordLabel(swap.record, marketNoun(swap.pick.category))}</span>
      </p>
      <PickCard pick={swap.pick} records={records} loading={false} />
    </div>
  );
}

export function ResultColumn({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-brand-200 bg-brand-50/60 p-4 dark:border-brand-800 dark:bg-brand-500/10">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mb-3 text-xs text-muted-foreground">{subtitle}</p>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

export function SwapColumn({ parlay, records }: { parlay: SwapParlay; records: CapperLeagueRecords }) {
  const copy = SWAP_COPY[parlay.mode];
  return (
    <ResultColumn
      title={`${copy.title} — ${parlay.legs.length}-leg parlay`}
      subtitle={`${parlay.swapCount} of ${parlay.legs.length} legs ${copy.verb}`}
    >
      {parlay.legs.map((leg) => (
        // Keyed by the primary's own pickId, not gameId - Auto-Generate's
        // parlayA has one leg per game so either would be unique, but the
        // pool-driven primary can have two legs from the same game (a
        // side + a total, say), so gameId alone would collide.
        <SwapLegView key={leg.original.pick.pickId} leg={leg} mode={parlay.mode} records={records} />
      ))}
    </ResultColumn>
  );
}
