"use client";

// The /parlay page under its banner: three stat tiles over the one Parlay
// Generator card (generator-card.tsx). The tiles read the slip and, for legs,
// the last build - nothing is fetched for them.
import { useState } from "react";
import { StatCard } from "@/components/dashboard/stat-card";
import { TINTS } from "@/components/dashboard/panel-shell";
import { ClipboardIcon, ListChecksIcon, TargetIcon } from "@/components/dashboard/cappers-icons";
import { useParlayPool } from "@/components/parlay/parlay-pool-context";
import { GeneratorCard, type GeneratorSummary } from "@/components/parlay/generator-card";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import { effectiveFillFrom, effectiveManualSlots } from "@/lib/parlay/combined-fill";
import { legsSplitSub, yourPicksSub } from "@/lib/parlay/combined-ui";

const ICON = "h-[17px] w-[17px] stroke-[2.2]";

function ParlayStatCards({ summary }: { summary: GeneratorSummary }) {
  const { pool, targets, targetedGames, legCount, generatorFilters } = useParlayPool();
  // The same Fill from and split the card builds with (combined-fill.ts).
  const fillFrom = effectiveFillFrom(pool.length, generatorFilters.fillFrom);
  const manualSlots = fillFrom === "COMBINED" ? effectiveManualSlots(generatorFilters.manualSplit, legCount, pool.length) : 0;
  const legs = summary?.legs ?? legCount;
  // Before a build: what these settings ask for.
  const plannedSlip = fillFrom === "COMBINED" ? manualSlots : Math.min(pool.length, legCount);
  const fromSlip = summary?.fromSlip ?? plannedSlip;
  const generated = summary?.generated ?? (fillFrom === "YOUR_PICKS_ONLY" ? 0 : Math.max(0, legCount - plannedSlip));
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
      <StatCard
        glass
        label="Your picks"
        icon={<ClipboardIcon className={ICON} />}
        iconClass={TINTS.blue.iconWrap}
        color="#2563EB"
        value={String(pool.length)}
        sub={yourPicksSub(fillFrom, pool.length, manualSlots)}
      />
      <StatCard
        glass
        label="Targeting"
        icon={<TargetIcon className={ICON} />}
        iconClass={TINTS.violet.iconWrap}
        color="#7C3AED"
        value={targets.length === 0 ? "Full slate" : `${targetedGames.length} game${targetedGames.length === 1 ? "" : "s"}`}
        sub={targets.length === 0 ? "every unstarted game in your leagues" : "targeted games and your picks' games"}
      />
      <StatCard
        glass
        label="Legs"
        icon={<ListChecksIcon className={ICON} />}
        iconClass={TINTS.green.iconWrap}
        color="#16A34A"
        value={`${legs} of ${MAX_PARLAY_LEGS} max`}
        sub={legsSplitSub(fromSlip, generated)}
      />
    </div>
  );
}

export function ParlayWorkspace({ leagues, hasFavorites = true }: { leagues: string[]; hasFavorites?: boolean }) {
  const [summary, setSummary] = useState<GeneratorSummary>(null);
  return (
    <div className="parlay-glass space-y-3.5 p-3.5 sm:p-5">
      <ParlayStatCards summary={summary} />
      <GeneratorCard leagues={leagues} hasFavorites={hasFavorites} onSummary={setSummary} />
    </div>
  );
}
