"use client";

// Two small inline glyphs rather than a new icon-library dependency - this
// codebase has none (grep confirms no lucide/heroicons/react-icons), and
// everywhere else that needs a lightweight icon (e.g. the "✕" remove button
// in the workspaces) just inlines it.
function ExpandIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} className="h-4 w-4">
      <path d="M7 3H3v4M13 3h4v4M7 17H3v-4M13 17h4v-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} className="h-4 w-4">
      <path d="M3 7h4V3M17 7h-4V3M3 13h4v4M17 13h-4v4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Same control in all three /charts modes (ChartsWorkspace, Team
// Comparison, Capper Comparison) - always toggles the SAME useFullscreen
// instance's `toggle`, whether the click came from this button or a
// double-click on the chart itself, so both entry points stay in sync with
// one source of truth for fullscreen state.
export function FullscreenButton({ isFullscreen, onClick }: { isFullscreen: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
      className="rounded-lg border border-border bg-card p-1.5 text-muted-foreground shadow-soft transition hover:bg-muted hover:text-foreground"
    >
      {isFullscreen ? <CollapseIcon /> : <ExpandIcon />}
    </button>
  );
}
