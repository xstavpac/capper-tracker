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

const ICON = "h-[17px] w-[17px] stroke-[2.2]";

function ParlayStatCards({ summary }: { summary: GeneratorSummary }) {
  const { pool, targets, targetedGames, legCount } = useParlayPool();
  const legs = summary?.legs ?? legCount;
  const fromSlip = summary?.fromSlip ?? Math.min(pool.length, legCount);
  const generated = summary?.generated ?? Math.max(0, legCount - pool.length);
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
      <StatCard
        label="Your picks"
        icon={<ClipboardIcon className={ICON} />}
        iconClass={TINTS.blue.iconWrap}
        color="#2563EB"
        value={String(pool.length)}
        sub="always in the parlay"
      />
      <StatCard
        label="Targeting"
        icon={<TargetIcon className={ICON} />}
        iconClass={TINTS.violet.iconWrap}
        color="#7C3AED"
        value={targets.length === 0 ? "Full slate" : `${targetedGames.length} game${targetedGames.length === 1 ? "" : "s"}`}
        sub={targets.length === 0 ? "every unstarted game in your leagues" : "targeted games and your picks' games"}
      />
      <StatCard
        label="Legs"
        icon={<ListChecksIcon className={ICON} />}
        iconClass={TINTS.green.iconWrap}
        color="#16A34A"
        value={`${legs} of ${MAX_PARLAY_LEGS} max`}
        sub={`${fromSlip} from your picks · ${generated} generated`}
      />
    </div>
  );
}

export function ParlayWorkspace({ leagues }: { leagues: string[] }) {
  const [summary, setSummary] = useState<GeneratorSummary>(null);
  return (
    <>
      <ParlayStatCards summary={summary} />
      <GeneratorCard leagues={leagues} onSummary={setSummary} />
    </>
  );
}
