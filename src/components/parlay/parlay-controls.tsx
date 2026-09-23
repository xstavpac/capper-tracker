"use client";

// The Parlay Generator's shared controls - the per-league scope switch and
// the leg-count stepper. Presentational only (state comes in as props) so
// My Picks (backed by the Parlay Pool context) and Auto-Generate (its own
// local state, so it never changes the user's pool scope) render the
// identical control.

export function ScopeToggle({
  inScope,
  onToggle,
  ariaLabel,
}: {
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
      className="flex items-center gap-2 rounded-full bg-muted/60 py-1 pl-1 pr-2.5"
    >
      <span
        className={
          "relative h-5 w-9 shrink-0 rounded-full transition " + (inScope ? "bg-brand-600" : "bg-muted-foreground/30")
        }
      >
        <span
          className={
            "absolute top-0.5 h-4 w-4 rounded-full bg-card shadow-soft transition " +
            (inScope ? "left-[18px]" : "left-0.5")
          }
        />
      </span>
      <span className="text-xs font-medium text-foreground">{inScope ? "In scope" : "Excluded"}</span>
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
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium text-foreground">Legs</span>
      <div className="flex items-center gap-1 rounded-full border border-border-subtle">
        <button
          type="button"
          onClick={() => onChange(value - 1)}
          disabled={value <= 1}
          aria-label="Fewer legs"
          className="flex h-7 w-7 items-center justify-center text-foreground disabled:opacity-30"
        >
          &minus;
        </button>
        <span className="w-6 text-center text-sm font-semibold text-foreground">{value}</span>
        <button
          type="button"
          onClick={() => onChange(value + 1)}
          disabled={value >= max}
          aria-label="More legs"
          className="flex h-7 w-7 items-center justify-center text-foreground disabled:opacity-30"
        >
          +
        </button>
      </div>
      <span className="text-xs text-muted-foreground">{note}</span>
    </div>
  );
}
