"use client";

// The Parlay Generator's shared controls - the per-league scope chip, the
// leg-count stepper, the result tabs and the pill buttons. Presentational
// only (state comes in as props) so My Picks (backed by the Parlay Pool
// context) and Auto-Generate (its own local state, so it never changes the
// user's pool scope) render the identical control.
import { useState, type ReactNode } from "react";
import { MUTED } from "@/components/dashboard/stat-card";
import { MAX_PARLAY_LEGS, MAX_PARLAY_LEGS_MESSAGE } from "@/lib/parlay/leg-cap";

// The small uppercase label of the stat cards (stat-card.tsx).
export const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.07em] " + MUTED;

// The white outlined surface every unselected control sits on (the panels' own control border).
const OUTLINED = "pill-inactive hover:bg-white/80";
const FILLED = "pill-active border-transparent";

// 44px tall: a full touch target.
const PILL = "inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-full border px-5 text-sm font-semibold transition disabled:opacity-50 ";
export const PILL_PRIMARY = PILL + FILLED + " hover:brightness-110";
export const PILL_OUTLINE = PILL + OUTLINED;
// The group a row of segments or tabs sits in.
export const SEGMENT_GROUP = "glass-card-soft rounded-2xl p-1";
export const SEGMENT_ON = "pill-active";
// A segment that can't be chosen: grayed text, a dashed light border, a light gray fill.
export const SEGMENT_DISABLED =
  "cursor-not-allowed !border-dashed !border-[#d3dae6] bg-[#f3f5f9] text-[#a3afc2] dark:!border-white/15 dark:bg-white/[0.04] dark:text-[#5f6b80]";
export const SEGMENT_OFF = "text-[#243a5e] hover:bg-white/50 dark:text-foreground dark:hover:bg-foreground/[0.035]";

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

// Just the control (the Total Legs row of Pick Filters supplies the label and the note).
export function LegStepper({
  value,
  max,
  min = 1,
  onChange,
}: {
  value: number;
  max: number;
  // The fewest legs allowed (Best available: the picks sent). "-" is disabled at it.
  min?: number;
  onChange: (n: number) => void;
}) {
  // `max` is what the caller can supply right now (a pool's in-scope picks,
  // or the cap itself); MAX_PARLAY_LEGS is the ceiling no caller goes past.
  // Below the cap "+" just disables at `max`. At the cap it stays live, so
  // asking for one more is answered with the limit rather than with nothing.
  const [overCap, setOverCap] = useState(false);
  const atCap = value >= MAX_PARLAY_LEGS;
  const step = "glass-card flex h-6 w-6 items-center justify-center rounded-full text-sm leading-none text-[#243a5e] transition hover:bg-white/80 disabled:opacity-30 disabled:hover:bg-white/55 dark:text-foreground";
  return (
    <>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            setOverCap(false);
            onChange(value - 1);
          }}
          disabled={value <= Math.max(1, min)}
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
      {overCap && atCap && (
        <span role="alert" className="text-xs font-semibold text-amber-700 dark:text-amber-400">
          {MAX_PARLAY_LEGS_MESSAGE}
        </span>
      )}
    </>
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
      <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5 glass-card-soft rounded-full p-0.5">
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
  disabled = [],
  disabledTitle,
}: {
  label: string;
  options: readonly { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
  // Options that can't be picked right now: shown grayed, dashed border, not-allowed, with disabledTitle on hover.
  disabled?: readonly T[];
  disabledTitle?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5 glass-card-soft rounded-full p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          disabled={disabled.includes(o.key)}
          title={disabled.includes(o.key) ? disabledTitle : undefined}
          onClick={() => onChange(o.key)}
          className={
            "flex h-10 items-center justify-center whitespace-nowrap rounded-full border border-transparent px-3.5 text-[13.5px] font-semibold transition " +
            (disabled.includes(o.key) ? SEGMENT_DISABLED : o.key === value ? SEGMENT_ON : SEGMENT_OFF)
          }
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

// The −/+ group of a bounded count, without a label: the settings rows lay the label out themselves.
export function StepperControl({
  label,
  value,
  min,
  max,
  onChange,
  step: stepBy = 1,
  unit = "",
}: {
  // Names the buttons for assistive tech ("Fewer: Max legs per game").
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  // How far − and + move the value, and what follows it ("%").
  step?: number;
  unit?: string;
}) {
  const step = "glass-card flex h-6 w-6 items-center justify-center rounded-full text-sm leading-none text-[#243a5e] transition hover:bg-white/80 disabled:opacity-30 disabled:hover:bg-white/55 dark:text-foreground";
  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={() => onChange(value - stepBy)} disabled={value <= min} aria-label={"Fewer: " + label} className={step}>
        &minus;
      </button>
      <span className={(unit ? "w-12" : "w-8") + " text-center text-[15px] font-semibold tabular-nums text-foreground"} aria-live="polite">
        {value}
        {unit}
      </span>
      <button type="button" onClick={() => onChange(value + stepBy)} disabled={value >= max} aria-label={"More: " + label} className={step}>
        +
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The generator card's layout pieces: numbered sections, filter rows, and the
// tinted settings block.
// ---------------------------------------------------------------------------

const SECTION_RULE = "border-t border-[#0F1420]/[0.08] dark:border-white/10";

// The round number beside a section's title: green for the picks, blue for the rest.
function StepBadge({ n, tone }: { n: number; tone: "green" | "blue" }) {
  return (
    <span
      aria-hidden
      className={"flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white " + (tone === "green" ? "bg-[#16A34A] dark:bg-emerald-600" : "bg-brand-600")}
    >
      {n}
    </span>
  );
}

// One numbered section: badge, title, a one-line description, and its actions
// right-aligned on the title's row (they wrap under it on a phone).
export function Section({
  n,
  tone = "blue",
  title,
  description,
  actions,
  children,
}: {
  n: number;
  tone?: "green" | "blue";
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section aria-label={title} className={"mt-3.5 pt-3.5 " + SECTION_RULE}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-start gap-3">
          <StepBadge n={n} tone={tone} />
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold leading-7 text-foreground">{title}</h3>
            <p className="-mt-1 text-xs font-medium text-muted-foreground">{description}</p>
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}

// A compact on/off switch the size of the Favorites pill: its label, then a small track. Pick Filters'
// "Include live games".
export function PillSwitch({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className="pill-inactive inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition hover:text-foreground"
    >
      {label}
      <span aria-hidden="true" className={"relative inline-block h-4 w-7 shrink-0 rounded-full transition " + (on ? "bg-brand-600" : "bg-[#C9CEDA] dark:bg-white/20")}>
        <span className={"absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all " + (on ? "left-[14px]" : "left-0.5")} />
      </span>
    </button>
  );
}

// LEAGUES / BET TYPES: an uppercase label, then the chips on its row (under it on a phone).
export function FilterRow({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={"flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3 " + className}>
      <span className={LABEL + " shrink-0 sm:w-[84px]"}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">{children}</div>
    </div>
  );
}

// The tinted, rounded block the settings rows sit in, thin dividers between them.
export function SettingsBlock({ children }: { children: ReactNode }) {
  return (
    <div className="glass-card-soft divide-y divide-[#0F1420]/[0.06] rounded-[14px] px-3.5 dark:divide-white/10">
      {children}
    </div>
  );
}

// One setting: icon + uppercase label, the control, then its helper text. Three
// columns from `sm` up (so every row's control lines up); stacked on a phone.
// `soft` puts the icon in a soft round tile (Line Flexibility) rather than bare.
export function SettingRow({ icon, label, note, soft, children }: { icon: ReactNode; label: string; note?: ReactNode; soft?: boolean; children: ReactNode }) {
  return (
    <div className={"grid items-center gap-x-4 gap-y-2 sm:grid-cols-[200px_auto_minmax(0,1fr)] " + (soft ? "py-2" : "py-3")}>
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className={"flex shrink-0 items-center justify-center " + (soft ? "h-10 w-10 rounded-full bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400" : "h-6 w-6 text-[#5B6275] dark:text-muted-foreground")}
        >
          {icon}
        </span>
        <span className={LABEL}>{label}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
      {note && <p className="text-xs font-medium text-muted-foreground">{note}</p>}
    </div>
  );
}
