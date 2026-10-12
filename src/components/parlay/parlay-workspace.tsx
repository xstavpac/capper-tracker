"use client";

// The /parlay page under its banner: the stat tiles, Auto-Generate (with its
// result) and My Picks. Auto-Generate and My Picks stay separate flows with
// their own scope, leg count and builders; all this holds is what the last
// Auto-Generate found, for the third tile.
import { useState, type ReactNode } from "react";
import { StatCard } from "@/components/dashboard/stat-card";
import { TINTS } from "@/components/dashboard/panel-shell";
import { CalendarIcon, ClipboardIcon, TargetIcon } from "@/components/dashboard/cappers-icons";
import { useParlayPool } from "@/components/parlay/parlay-pool-context";
import { AutoGenerateSection, type GeneratedSummary } from "@/components/parlay/auto-generate-section";
import { ParlayPoolSection } from "@/components/parlay/parlay-pool-section";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import { autoGenerateWindowText } from "@/lib/parlay/auto-generate-window";

const ICON = "h-[17px] w-[17px] stroke-[2.2]";

// Three numbers the page already has: the slip's picks, how many of them are
// in a league that is switched on, and - once a parlay has been generated -
// how many unstarted games in its window had a pick. Nothing is read for these.
function ParlayStatCards({ generated }: { generated: GeneratedSummary | null }) {
  const { pool, leaguesInPool, isLeagueInScope } = useParlayPool();
  const inScope = pool.filter((p) => isLeagueInScope(p.leagueName)).length;
  const leaguesOn = leaguesInPool.filter(isLeagueInScope).length;
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
      <StatCard
        label="In your slip"
        icon={<ClipboardIcon className={ICON} />}
        iconClass={TINTS.blue.iconWrap}
        color="#2563EB"
        value={String(pool.length)}
        sub={"up to " + MAX_PARLAY_LEGS + " picks"}
      />
      <StatCard
        label="In scope"
        icon={<TargetIcon className={ICON} />}
        iconClass={TINTS.violet.iconWrap}
        color="#7C3AED"
        value={String(inScope)}
        sub={pool.length === 0 ? "no picks yet" : leaguesOn + " of " + leaguesInPool.length + " league" + (leaguesInPool.length === 1 ? "" : "s") + " on"}
      />
      <StatCard
        label="Games with picks"
        icon={<CalendarIcon className={ICON} />}
        iconClass={TINTS.green.iconWrap}
        color="#16A34A"
        value={generated ? String(generated.gamesWithPicks) : "—"}
        sub={generated ? autoGenerateWindowText(generated.leagues) + " in " + generated.leagues.join(", ") : "shown after you generate"}
      />
    </div>
  );
}

export function ParlayWorkspace({ leagues, addPicksLink }: { leagues: string[]; addPicksLink: ReactNode }) {
  const [generated, setGenerated] = useState<GeneratedSummary | null>(null);
  return (
    <>
      <ParlayStatCards generated={generated} />
      <AutoGenerateSection leagues={leagues} onGenerated={setGenerated} />
      <ParlayPoolSection action={addPicksLink} />
    </>
  );
}
