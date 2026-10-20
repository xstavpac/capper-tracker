"use client";

// The Parlay Generator's "Include Picks" chips, its "Customize Mix" link, the
// Pick Mix popover, and the chip that shows an active mix ("ML 40 · Totals 60
// ✕"). Presentational: the selection and the mix live in the generator card
// (generator-card.tsx, session-only React state) and come in as props; the
// rules are include-picks.ts.
//
// The popover edits a draft - one row per selected category, a whole % each,
// stepped by 5 or typed. The shares needn't add up to 100: they are scaled
// when the parlay is built. Done saves the draft (all 0 is no mix), Cancel /
// outside click / Escape throw it away. The chip reopens the popover; its ✕
// clears the mix back to none (pure ranking, no shares).
import { useEffect, useRef, useState } from "react";
import { PILL_OUTLINE, PILL_PRIMARY, SEGMENT_OFF, SEGMENT_ON } from "@/components/parlay/parlay-controls";
import { BET_CATEGORIES, BET_CATEGORY_LABELS, type BetCategory } from "@/lib/parlay/bet-category";
import {
  clampPct,
  evenMix,
  mixChipText,
  mixCountsText,
  mixTotal,
  stepPct,
  type IncludeSelection,
  type PickMix,
} from "@/lib/parlay/include-picks";

const LINK = "text-[13px] font-semibold text-brand-600 hover:underline dark:text-brand-400";
const CHIP_ON = SEGMENT_ON + " border-brand-600";
const CHIP_OFF = SEGMENT_OFF + " border-[#DADDE5] bg-white dark:border-border dark:bg-card";

const INCLUDE_OPTIONS: { key: "ALL" | BetCategory; label: string }[] = [
  { key: "ALL", label: "All Picks" },
  ...BET_CATEGORIES.map((c) => ({ key: c, label: BET_CATEGORY_LABELS[c] })),
];

export function IncludePicksChips({ value, onToggle }: { value: IncludeSelection; onToggle: (key: "ALL" | BetCategory) => void }) {
  return (
    <div role="group" aria-label="Include picks" className="flex flex-wrap gap-1.5">
      {INCLUDE_OPTIONS.map((o) => {
        const on = o.key === "ALL" ? value === "ALL" : value !== "ALL" && value.includes(o.key);
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(o.key)}
            className={"flex h-10 items-center whitespace-nowrap rounded-full border px-3.5 text-[13.5px] font-semibold transition " + (on ? CHIP_ON : CHIP_OFF)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const STEP_BUTTON =
  "flex h-9 w-9 items-center justify-center rounded-full text-base text-foreground transition hover:bg-foreground/[0.035] disabled:opacity-30 disabled:hover:bg-transparent";

export function PickMixControl({
  categories,
  mix,
  legCount,
  onChange,
}: {
  // Two or more - the card shows no mix for one.
  categories: BetCategory[];
  mix: PickMix | null;
  legCount: number;
  onChange: (mix: PickMix | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PickMix>(() => mix ?? evenMix(categories));
  const ref = useRef<HTMLDivElement>(null);
  const total = mixTotal(draft, categories);

  function openPopover() {
    setDraft(mix ?? evenMix(categories));
    setOpen(true);
  }
  const setShare = (c: BetCategory, pct: number) => setDraft((d) => ({ ...d, [c]: clampPct(pct) }));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={openPopover} aria-haspopup="dialog" aria-expanded={open} className={LINK + " px-1 py-2.5"}>
        Customize Mix
      </button>
      {mix !== null && (
        <span className="inline-flex h-8 items-center rounded-full border border-brand-600/30 bg-[#E6ECFF] text-[12.5px] font-semibold tabular-nums text-brand-700 dark:border-brand-400/30 dark:bg-brand-500/15 dark:text-brand-300">
          <button type="button" onClick={openPopover} aria-label={`Edit pick mix, ${mixChipText(mix, categories)}`} className="h-full rounded-l-full pl-3 pr-1.5">
            {mixChipText(mix, categories)}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onChange(null);
            }}
            aria-label="Clear pick mix"
            className="flex h-full w-7 items-center justify-center rounded-r-full hover:bg-brand-600/10"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Pick Mix"
          className="absolute left-0 top-full z-30 mt-2 w-full max-w-sm rounded-[14px] border border-[#DADDE5] bg-white p-4 shadow-lg dark:border-border dark:bg-card"
        >
          <h3 className="text-sm font-semibold text-foreground">Pick Mix</h3>
          <p className="mt-0.5 text-xs font-medium text-muted-foreground">Set each category&apos;s share of the parlay&apos;s legs.</p>

          <div className="mt-3 space-y-1.5">
            {categories.map((c) => {
              const pct = draft[c] ?? 0;
              const label = BET_CATEGORY_LABELS[c];
              return (
                <div key={c} className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-semibold text-foreground">{label}</span>
                  <div className="flex items-center rounded-full border border-[#DADDE5] bg-white dark:border-border dark:bg-card">
                    <button type="button" onClick={() => setShare(c, stepPct(pct, -1))} disabled={pct <= 0} aria-label={`Less ${label}`} className={STEP_BUTTON}>
                      &minus;
                    </button>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={100}
                      step={1}
                      value={pct}
                      onChange={(e) => setShare(c, e.target.value === "" ? 0 : Number(e.target.value))}
                      aria-label={`${label} share, percent`}
                      className="w-11 appearance-none bg-transparent text-center text-[14px] font-semibold tabular-nums text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <span className="-ml-1 text-[13px] font-semibold text-muted-foreground">%</span>
                    <button type="button" onClick={() => setShare(c, stepPct(pct, 1))} disabled={pct >= 100} aria-label={`More ${label}`} className={STEP_BUTTON}>
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-[13px] font-semibold tabular-nums text-foreground" aria-live="polite">
              Total: {total}%
            </p>
            <button type="button" onClick={() => setDraft(evenMix(categories))} className={LINK}>
              Even split
            </button>
          </div>
          {total !== 100 && (
            <p className="mt-0.5 text-xs font-medium text-muted-foreground">
              {total === 0 ? "All 0% is no mix." : "Shares are scaled to 100% when the parlay is built."}
            </p>
          )}
          {total > 0 && <p className="mt-1.5 text-[13px] font-semibold tabular-nums text-foreground">{mixCountsText(legCount, draft, categories)}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className={PILL_OUTLINE}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onChange(total > 0 ? Object.fromEntries(categories.map((c) => [c, draft[c] ?? 0])) : null);
                setOpen(false);
              }}
              className={PILL_PRIMARY}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
