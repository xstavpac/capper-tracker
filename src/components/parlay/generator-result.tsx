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
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { getRecordColor, PICK_CATEGORY_LABELS, PICK_CATEGORY_MARKET_NOUN } from "@/server/data/stats";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { GREEN, MUTED, RED } from "@/components/dashboard/stat-card";
import { CONTROL, PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { WIN_PCT_TRACK, WinPctBar } from "@/components/dashboard/category-card";
import { ClipboardIcon, ListChecksIcon, RefreshIcon } from "@/components/dashboard/cappers-icons";
import { LABEL, Tabs, TextSegments } from "@/components/parlay/parlay-controls";
import { SendToFanDuel } from "@/components/parlay/send-to-fanduel";
import { combineOdds, formatAmericanOdds, formatDecimalOdds, formatPayout, hasUsablePrice, payoutOn, type CombineLeg } from "@/lib/parlay/combine-odds";
import { isGameLive, LIVE_NOTE, type GameClock } from "@/lib/parlay/game-over";
import type { EngineLeg, EngineSwap, EngineSwapLeg, GeneratedParlay, LegRecord } from "@/lib/parlay/generator";
import type { RankRecordSource } from "@/lib/parlay/pick-record";
import { SWAP_SCOPE_OPTIONS, type SwapScope } from "@/lib/parlay/swap-scope";

export const formatOdds = (odds: number) => (odds > 0 ? "+" : "") + odds;
export const formatGameTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const plural = (n: number) => (n === 1 ? "" : "s");
const LEG_LIST = "divide-y divide-[#0F1420]/[0.06] dark:divide-white/10";
const TAG = "ml-1.5 rounded-full px-1.5 py-px text-[10px] font-bold";

// "62% (106–65)" plus what the record is: "· NFL favorite spread" (this
// league, this market), "· all leagues favorite spread" (this market, every
// league) or "· last 20 picks" (a slip pick's card, nothing better).
export function recordText(record: LegRecord | null, basis: EngineLeg["basis"], pick: Pick<ExpanderPick, "category" | "leagueName">): string {
  if (!record) return "No record yet";
  const base = `${Math.round(record.winPct)}% (${record.wins}–${record.losses})`;
  const market = pick.category ? PICK_CATEGORY_MARKET_NOUN[pick.category] : "this market";
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

function LegRow({ n, pick, record, mine, sgp, swappedBy, children }: { n: number; pick: ExpanderPick; record: { text: string; winPct: number | null }; mine: boolean; sgp: boolean; swappedBy?: string; children?: ReactNode }) {
  const tone = record.winPct === null ? MUTED : getRecordColor(record.winPct) === "green" ? GREEN : RED;
  const live = isGameLive(pick, new Date());
  return (
    <li className={"flex gap-3 py-3 " + (swappedBy ? SWAPPED_FRAME : "")}>
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
        </p>
        <div className="mt-0.5 flex items-baseline justify-between gap-3">
          <p className={"min-w-0 text-[15px] font-bold leading-snug [overflow-wrap:anywhere] " + (swappedBy ? SWAPPED_TEXT : "text-foreground")}>
            {swappedBy && <span className="sr-only">Swapped by {swappedBy}: </span>}
            {pick.betDetail}
          </p>
          <p className={"shrink-0 text-sm font-semibold tabular-nums " + (swappedBy ? SWAPPED_TEXT : "text-foreground")}>{formatOdds(pick.odds)}</p>
        </div>
        <p className="text-xs font-medium text-muted-foreground">
          <Link href={"/cappers/" + pick.capperId} className="text-foreground hover:underline">
            {pick.capperName}
          </Link>
          {pick.category && " · " + PICK_CATEGORY_LABELS[pick.category]}
        </p>
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
  AUTO_HEDGE: { title: "Hedge", verb: "hedged", noAlternate: "no other bet on this game clears 55% in its market and fits" },
  CONTRARIAN: { title: "Contrarian", verb: "flipped", noAlternate: "no capper on the other side clears 55% in this market" },
} as const;

function SwapLegRow({ n, leg, mode }: { n: number; leg: EngineSwapLeg; mode: EngineSwap["mode"] }) {
  const { original } = leg;
  if (!leg.swap) {
    const reason =
      leg.unchangedReason === "OUT_OF_SCOPE"
        ? original.source === "SLIP"
          ? "your pick - Swap is set to Suggested"
          : "suggested leg - Swap is set to Your picks"
        : leg.unchangedReason === "NOT_MAJORITY"
          ? "your pick's side isn't the majority of your cappers"
          : SWAP_COPY[mode].noAlternate;
    return (
      <LegRow n={n} pick={original.pick} record={{ text: recordText(original.record, original.basis, original.pick), winPct: original.record?.winPct ?? null }} mine={original.source === "SLIP"} sgp={original.sameGame}>
        <p className={NOTE}>
          <span className="rounded-full bg-muted px-1.5 py-0.5 font-semibold">Unchanged</span> {reason}
        </p>
      </LegRow>
    );
  }
  const { swap } = leg;
  return (
    <LegRow n={n} pick={swap.pick} record={{ text: recordText(swap.record, swap.basis ?? "MARKET", swap.pick), winPct: swap.record.winPct }} mine={false} sgp={original.sameGame} swappedBy={SWAP_COPY[mode].title}>
      <p className={NOTE}>
        Replaces {original.source === "SLIP" && "your pick "}
        <span className="line-through">{original.pick.betDetail}</span> · {original.pick.capperName}
      </p>
    </LegRow>
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
export function CombinedPrice({ legs, sameGame }: { legs: (CombineLeg & Partial<GameClock>)[]; sameGame: boolean }) {
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
  const combined = combineOdds(legs);
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
  return (
    <div className={PRICE_BOX}>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
        <PriceCell label={(combined.estimated ? "Combined odds (estimate)" : "Combined odds") + asPosted} value={approx + formatAmericanOdds(combined.american)} />
        <PriceCell label="Decimal" value={approx + formatDecimalOdds(combined.decimal)} />
        <PriceCell label="Payout" value={approx + formatPayout(payoutOn(combined))} sub="on $1" />
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

// The header's Regenerate: an accent-outlined pill exactly as tall as the "N legs" chip (26px), with an
// invisible 10px of hit area above and below (from inside the 1px border) so the tap target is 44px.
const REGENERATE =
  "relative inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-brand-600 bg-white px-2.5 py-1 text-xs font-semibold text-brand-600 transition hover:bg-brand-600/[0.06] disabled:opacity-50 dark:border-brand-400 dark:bg-card dark:text-brand-400 dark:hover:bg-brand-400/10 after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-['']";

type Tab = "PRIMARY" | "AUTO_HEDGE" | "CONTRARIAN";
const sendLegs = (picks: ExpanderPick[]) => picks.map((p) => ({ pickId: p.pickId, betDetail: p.betDetail, gameId: p.gameId, gameLabel: p.gameLabel }));

export function GeneratorResult({
  parlay,
  busy,
  noAlternative,
  unavailableTargetLabels,
  swapScope,
  onSwapScope,
  onRegenerate,
  onSent,
}: {
  parlay: GeneratedParlay;
  busy: boolean;
  // Which legs Hedge and Contrarian swap (swap-scope.ts); remembered by the card.
  swapScope: SwapScope;
  onSwapScope: (scope: SwapScope) => void;
  // The last Regenerate found nothing else of comparable strength.
  noAlternative: boolean;
  // Targeted games that are over or have left the board, by name.
  unavailableTargetLabels: string[];
  onRegenerate: () => void;
  // The user opened FanDuel's betslip with this parlay.
  onSent: () => void;
}) {
  const [tab, setTab] = useState<Tab>("PRIMARY");
  const legs = parlay.legs;
  const sameGame = parlay.sameGameGames > 0;
  const hedge = parlay.hedge[swapScope];
  const contrarian = parlay.contrarian[swapScope];
  const swap = tab === "AUTO_HEDGE" ? hedge : tab === "CONTRARIAN" ? contrarian : null;
  const shownPicks = swap ? swap.legs.map((l) => (l.swap ?? l.original).pick) : legs.map((l) => l.pick);
  const regenerateHint = noAlternative ? "No other parlays of comparable strength" : "Another parlay of comparable strength";
  const notes = [
    ...parlay.dropped.filter((d) => d.reason === "left_out").map((d) => `${d.label}: ${d.note}`),
    ...parlay.shortfall,
    ...parlay.mixNotes,
    ...(unavailableTargetLabels.length > 0
      ? [`${unavailableTargetLabels.join(", ")}: over or no longer on the board — not used.`]
      : []),
  ];

  return (
    <PanelShell
      theme={{
        ...TINTS.neutral,
        title: `Your parlay · ${legs.length} leg${plural(legs.length)}`,
        subtitle:
          `${parlay.gamesUsed} game${plural(parlay.gamesUsed)}` +
          (sameGame ? ` · ${parlay.sameGameGames} same-game pair${plural(parlay.sameGameGames)}` : "") +
          ` · ${parlay.fromSlip} from your picks, ${parlay.generated} generated`,
        icon: <ListChecksIcon className="h-[17px] w-[17px] stroke-[2.2]" />,
      }}
      control={
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onRegenerate}
            disabled={busy}
            title={regenerateHint}
            aria-label={"Regenerate: " + regenerateHint}
            className={REGENERATE}
          >
            <RefreshIcon className="h-3.5 w-3.5 stroke-[2.4]" />
            {busy ? "Regenerating…" : "Regenerate"}
          </button>
          <span className={CONTROL + " shrink-0 px-2.5 py-1 " + TINTS.neutral.control}>{legs.length} legs</span>
        </div>
      }
      footer={null}
      busy={busy}
      wrapSubtitle
      wrapControl
    >
      {noAlternative && (
        <p role="status" className="mb-2 text-xs font-medium text-muted-foreground">
          No other parlays of comparable strength
        </p>
      )}
      <Tabs<Tab>
        label="Parlay variant"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "PRIMARY", label: "Primary" },
          { key: "AUTO_HEDGE", label: "Hedge", note: `${hedge.swapCount}/${hedge.legs.length}` },
          { key: "CONTRARIAN", label: "Contrarian", note: `${contrarian.swapCount}/${contrarian.legs.length}` },
        ]}
      />
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
        <CombinedPrice legs={shownPicks} sameGame={sameGame} />
        <ol className={LEG_LIST}>
          {swap
            ? swap.legs.map((l, i) => <SwapLegRow key={l.original.pick.pickId} n={i + 1} leg={l} mode={swap.mode} />)
            : legs.map((l, i) => (
                <LegRow
                  key={l.pick.pickId}
                  n={i + 1}
                  pick={l.pick}
                  record={{ text: recordText(l.record, l.basis, l.pick), winPct: l.record?.winPct ?? null }}
                  mine={l.source === "SLIP"}
                  sgp={l.sameGame}
                />
              ))}
        </ol>
        <SendToFanDuel legs={sendLegs(shownPicks)} onOpened={onSent} />
      </div>
    </PanelShell>
  );
}
