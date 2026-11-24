"use client";

// Fill from = Combined's mix box (generator.ts rule 7, combined-fill.ts): how many legs come from
// your picks (Manual Picks) and how many the generator picks (Auto Picks), set with one slider -
// one step per leg, 0 to min(Total legs, your picks). Shown only under Combined.
import { BoltIcon, PinIcon, RefreshIcon } from "@/components/dashboard/cappers-icons";
import { rotationFooter, splitPercents } from "@/lib/parlay/combined-ui";

export const MIX_SLIDER_LABEL = "Manual versus auto picks";

export function CombinedMixBox({ manual, total, max, slipSize, onChange }: { manual: number; total: number; max: number; slipSize: number; onChange: (n: number) => void }) {
  const auto = total - manual;
  const pct = splitPercents(manual, total);
  // The track fills blue up to the thumb, lavender after it.
  const fill = max > 0 ? (manual / max) * 100 : 0;
  return (
    <div
      data-mix-box
      className="w-full max-w-[600px] rounded-2xl border border-[#c9d9f8] bg-gradient-to-b from-[#f5f8ff] to-[#eef3ff] px-4 py-3.5 shadow-[0_6px_18px_rgba(47,107,255,0.10)] dark:border-[#2a3a63] dark:from-[#131c33] dark:to-[#101831] dark:shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#2f6bff] text-white">
              <PinIcon className="h-[18px] w-[18px] stroke-[2.2]" />
            </span>
            <p className="flex items-baseline gap-1.5">
              <span data-manual-count className="text-[26px] font-extrabold leading-none tabular-nums text-[#2f6bff] dark:text-[#6f9bff]">
                {manual}
              </span>
              <span className="text-sm font-semibold text-foreground">Manual Picks</span>
            </p>
          </div>
          <p className="mt-1.5 text-xs font-medium text-muted-foreground">Picks you&apos;ve personally selected from the capper catalog.</p>
        </div>
        <div className="min-w-0 text-right">
          <div className="flex items-center justify-end gap-2.5">
            <p className="flex items-baseline gap-1.5">
              <span className="text-sm font-semibold text-foreground">Auto Picks</span>
              <span data-auto-count className="text-[26px] font-extrabold leading-none tabular-nums text-[#4f46e5] dark:text-[#a5a1ff]">
                {auto}
              </span>
            </p>
            <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#e4e3fb] text-[#4f46e5] dark:bg-[#4f46e5]/25 dark:text-[#a5a1ff]">
              <BoltIcon className="h-[18px] w-[18px] stroke-[2.2]" />
            </span>
          </div>
          <p className="mt-1.5 text-xs font-medium text-muted-foreground">Picks independently selected by the generator.</p>
        </div>
      </div>

      <input
        type="range"
        aria-label={MIX_SLIDER_LABEL}
        aria-valuetext={pct.text}
        min={0}
        max={max}
        step={1}
        value={manual}
        disabled={max === 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mix-slider mt-4 block w-full"
        style={{ ["--mix-fill" as string]: `${fill}%` }}
      />
      <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">All auto</span>
        <span data-mix-pill className="rounded-full border border-[#c9d9f8] bg-white px-2.5 py-0.5 text-[11.5px] font-semibold tabular-nums text-foreground dark:border-[#2a3a63] dark:bg-card">
          {pct.text}
        </span>
        <span className="text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">All manual</span>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <RefreshIcon className="h-3.5 w-3.5 shrink-0 stroke-[2.4]" />
        {rotationFooter(slipSize)}
      </p>
    </div>
  );
}
