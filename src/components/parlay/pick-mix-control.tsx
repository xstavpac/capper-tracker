"use client";

// Auto-Generate's "Customize Mix" link, its Pick Mix popover, and the chip
// that shows an active mix ("60/40 ✕"). Presentational: the mix itself lives
// in AutoGenerateSection (session-only React state) and comes in as props.
//
// The popover edits a draft. Done saves it, Cancel / outside click / Escape
// throw it away. The chip reopens the popover; its ✕ clears the mix back to
// none (pure ranking, no quotas).
import { useEffect, useRef, useState } from "react";
import { PILL_OUTLINE, PILL_PRIMARY, SEGMENT_OFF, SEGMENT_ON } from "@/components/parlay/parlay-controls";
import { PICK_MIX_PRESETS, PICK_MIX_STEP, mixLabel, mixSplitText } from "@/lib/parlay/pick-mix";

// Where the draft starts when no mix is set yet.
const DEFAULT_DRAFT = 50;

const LINK = "text-[13px] font-semibold text-brand-600 hover:underline dark:text-brand-400";

export function PickMixControl({
  gameLinesPct,
  legCount,
  onChange,
}: {
  gameLinesPct: number | null;
  legCount: number;
  onChange: (pct: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(gameLinesPct ?? DEFAULT_DRAFT);
  const ref = useRef<HTMLDivElement>(null);

  function openPopover() {
    setDraft(gameLinesPct ?? DEFAULT_DRAFT);
    setOpen(true);
  }

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
      {gameLinesPct !== null && (
        <span className="inline-flex h-8 items-center rounded-full border border-brand-600/30 bg-[#E6ECFF] text-[12.5px] font-semibold tabular-nums text-brand-700 dark:border-brand-400/30 dark:bg-brand-500/15 dark:text-brand-300">
          <button type="button" onClick={openPopover} aria-label={`Edit pick mix, ${gameLinesPct}% game lines`} className="h-full rounded-l-full pl-3 pr-1.5">
            {gameLinesPct}/{100 - gameLinesPct}
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
          <p className="mt-0.5 text-xs font-medium text-muted-foreground">Set how many legs come from Game Lines vs Props when using All.</p>

          <div className="mt-3 flex items-baseline justify-between text-[12.5px] font-semibold tabular-nums text-foreground">
            <span>Game Lines {draft}%</span>
            <span>Props {100 - draft}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={PICK_MIX_STEP}
            value={draft}
            onChange={(e) => setDraft(Number(e.target.value))}
            aria-label="Game Lines share"
            aria-valuetext={`${draft}% game lines, ${100 - draft}% props`}
            className="mt-1.5 h-2 w-full cursor-pointer accent-brand-600"
          />

          <div className="mt-3 grid grid-cols-3 gap-1.5" role="group" aria-label="Presets">
            {PICK_MIX_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={p === draft}
                onClick={() => setDraft(p)}
                className={
                  "h-9 rounded-full border text-[12.5px] font-semibold tabular-nums transition " +
                  (p === draft ? SEGMENT_ON + " border-brand-600" : SEGMENT_OFF + " border-[#DADDE5] dark:border-border")
                }
              >
                {mixLabel(p).replace(/ /g, "")}
              </button>
            ))}
          </div>

          <p className="mt-3 text-[13px] font-semibold tabular-nums text-foreground" aria-live="polite">
            {mixSplitText(legCount, draft)}
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className={PILL_OUTLINE}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onChange(draft);
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
