// Presentational only - takes the { pct, label } getLiveGameProgress already
// computed (see lib/live-game-progress.ts), no data logic of its own. Two
// variants for the two places the Live page's per-game progress shows up:
// LiveProgressLabel (compact text, unselected Grid Live list cards) and
// LiveProgressBar (a full filled bar + label, the selected list card and the
// mobile game-detail panel). Red fill matches the existing LIVE pill's red
// (bg-red-600 / dark:bg-red-500) so "in progress" reads as one color across
// the page, not a second unrelated hue.
export function LiveProgressLabel({ label }: { label: string }) {
  return <span className="text-[11px] font-medium text-muted-foreground">{label}</span>;
}

export function LiveProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="mt-1.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        <span className="text-[11px] font-medium text-muted-foreground">{Math.round(pct)}%</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-red-600 dark:bg-red-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
