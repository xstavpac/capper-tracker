"use client";

// The Parlay Generator's shared controls - the per-league scope chip, the
// leg-count stepper, the result tabs and the pill buttons. Presentational
// only (state comes in as props) so My Picks (backed by the Parlay Pool
// context) and Auto-Generate (its own local state, so it never changes the
// user's pool scope) render the identical control.
import { useState } from "react";
import { MUTED } from "@/components/dashboard/stat-card";
import { MAX_PARLAY_LEGS, MAX_PARLAY_LEGS_MESSAGE } from "@/lib/parlay/leg-cap";

// The small uppercase label of the stat cards (stat-card.tsx).
export const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.07em] " + MUTED;

// The white outlined surface every unselected control sits on (the panels' own control border).
const OUTLINED = "border-[#DADDE5] bg-white text-foreground hover:bg-foreground/[0.035] dark:border-border dark:bg-card";
const FILLED = "border-brand-600 bg-brand-600 text-white";

// 44px tall: a full touch target.
const PILL = "inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-full border px-5 text-sm font-semibold transition disabled:opacity-50 ";
export const PILL_PRIMARY = PILL + FILLED + " hover:bg-brand-700";
export const PILL_OUTLINE = PILL + OUTLINED;
// The group a row of segments or tabs sits in.
export const SEGMENT_GROUP = "rounded-2xl border border-[#DADDE5] bg-white p-1 dark:border-border dark:bg-card";
export const SEGMENT_ON = "bg-brand-600 text-white";
export const SEGMENT_OFF = "text-foreground hover:bg-foreground/[0.035]";

// One league's scope: filled blue when its games/picks are in, white outlined
// when they are left out. `count` is how many it holds, where that is known.
export function ScopeChip({
  label,
  count,
  inScope,
  onToggle,
  ariaLabel,
}: {
  label: string;
  count?: number;
  inScope: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={inScope}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={"inline-flex h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition " + (inScope ? FILLED : OUTLINED)}
    >
      {label}
      {count !== undefined && (
        <span
          className={
            "rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums " +
            (inScope ? "bg-white/20" : "bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400")
          }
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function LegStepper({
  value,
  max,
  onChange,
  note,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
  note: string;
}) {
  // `max` is what the caller can supply right now (a pool's in-scope picks,
  // or the cap itself); MAX_PARLAY_LEGS is the ceiling no caller goes past.
  // Below the cap "+" just disables at `max`. At the cap it stays live, so
  // asking for one more is answered with the limit rather than with nothing.
  const [overCap, setOverCap] = useState(false);
  const atCap = value >= MAX_PARLAY_LEGS;
  const step = "flex h-11 w-11 items-center justify-center rounded-full text-lg text-foreground transition hover:bg-foreground/[0.035] disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className={LABEL}>Legs</span>
      <div className="flex items-center rounded-full border border-[#DADDE5] bg-white dark:border-border dark:bg-card">
        <button
          type="button"
          onClick={() => {
            setOverCap(false);
            onChange(value - 1);
          }}
          disabled={value <= 1}
          aria-label="Fewer legs"
          className={step}
        >
          &minus;
        </button>
        <span className="w-8 text-center text-[15px] font-semibold tabular-nums text-foreground">{value}</span>
        <button
          type="button"
          onClick={() => (atCap ? setOverCap(true) : onChange(value + 1))}
          disabled={value >= max && !atCap}
          aria-label="More legs"
          className={step}
        >
          +
        </button>
      </div>
      <span className="text-xs font-medium text-muted-foreground">{note}</span>
      {overCap && atCap && (
        <span role="alert" className="text-xs font-semibold text-amber-700 dark:text-amber-400">
          {MAX_PARLAY_LEGS_MESSAGE}
        </span>
      )}
    </div>
  );
}

// A short row of numbered choices, one on ("Max legs per game": 1 / 2 / 3).
export function NumberSegments<T extends number>({
  label,
  options,
  value,
  onChange,
  note,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (n: T) => void;
  note?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className={LABEL}>{label}</span>
      <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5 rounded-full border border-[#DADDE5] bg-white p-0.5 dark:border-border dark:bg-card">
        {options.map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={n === value}
            onClick={() => onChange(n)}
            className={"flex h-10 w-10 items-center justify-center rounded-full text-[15px] font-semibold tabular-nums transition " + (n === value ? SEGMENT_ON : SEGMENT_OFF)}
          >
            {n}
          </button>
        ))}
      </div>
      {note && <span className="text-xs font-medium text-muted-foreground">{note}</span>}
    </div>
  );
}

// The same pill row as NumberSegments, with words ("Include Picks": All /
// Game Lines / Props). Just the group - the caller lays out the label beside it.
export function TextSegments<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5 rounded-full border border-[#DADDE5] bg-white p-0.5 dark:border-border dark:bg-card">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          onClick={() => onChange(o.key)}
          className={"flex h-10 items-center justify-center whitespace-nowrap rounded-full px-3.5 text-[13.5px] font-semibold transition " + (o.key === value ? SEGMENT_ON : SEGMENT_OFF)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Which of a generated parlay's variants is shown. `note` is a small count beside the label.
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: { key: T; label: string; note?: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className={"flex gap-1 sm:inline-flex sm:self-start " + SEGMENT_GROUP}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === value}
          onClick={() => onChange(t.key)}
          className={
            "flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 text-[13px] font-semibold transition sm:flex-none sm:px-4 " +
            (t.key === value ? SEGMENT_ON : SEGMENT_OFF)
          }
        >
          {t.label}
          {t.note && <span className="text-[11px] font-medium tabular-nums opacity-75">{t.note}</span>}
        </button>
      ))}
    </div>
  );
}

// A small −/+ stepper for a bounded count ("Max legs per game": 1 to 5).
export function CountStepper({
  label,
  value,
  min,
  max,
  onChange,
  note,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  note?: string;
}) {
  const step = "flex h-11 w-11 items-center justify-center rounded-full text-lg text-foreground transition hover:bg-foreground/[0.035] disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className={LABEL}>{label}</span>
      <div className="flex items-center rounded-full border border-[#DADDE5] bg-white dark:border-border dark:bg-card">
        <button type="button" onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={"Fewer: " + label} className={step}>
          &minus;
        </button>
        <span className="w-8 text-center text-[15px] font-semibold tabular-nums text-foreground" aria-live="polite">
          {value}
        </span>
        <button type="button" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={"More: " + label} className={step}>
          +
        </button>
      </div>
      {note && <span className="text-xs font-medium text-muted-foreground">{note}</span>}
    </div>
  );
}
