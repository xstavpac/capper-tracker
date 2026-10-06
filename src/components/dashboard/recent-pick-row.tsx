import { PickStatusButtons } from "@/components/dashboard/pick-status-buttons";
import { formatPickLabel, betTypeLabel } from "@/lib/bet-line";
import { formatEastern } from "@/lib/dates";
import { leagueColorVars } from "@/lib/league-colors";
import { formatSignedUnits } from "@/lib/units-extremes";
import { unitsWonOnBet } from "@/server/data/stats";
import type { CapperPageView } from "@/server/data/capper-detail";

const PILL = "rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] ";
const RESULT = {
  WIN: { label: "Win", pill: "bg-[#D1FAE5] text-[#047857] dark:bg-emerald-500/20 dark:text-emerald-300", units: "text-[#059669] dark:text-emerald-400" },
  LOSS: { label: "Loss", pill: "bg-[#FEE2E2] text-[#B91C1C] dark:bg-red-500/20 dark:text-red-300", units: "text-[#DC2626] dark:text-red-400" },
  PUSH: { label: "Push", pill: "bg-[#E2E8F0] text-[#475569] dark:bg-white/10 dark:text-muted-foreground", units: "text-[#64748B] dark:text-muted-foreground" },
  CANCELLED: { label: "Cancelled", pill: "bg-[#E2E8F0] text-[#475569] dark:bg-white/10 dark:text-muted-foreground", units: "" },
};

// What a graded pick returned, in units. Null where there is nothing to show: a cancelled pick,
// or a WIN logged at odds 0 (no payout can be worked out from it).
function unitsResult(pick: { status: string; units: number; odds: number }): number | null {
  if (pick.status === "LOSS") return -pick.units;
  if (pick.status === "PUSH") return 0;
  if (pick.status !== "WIN") return null;
  const won = unitsWonOnBet(pick.units, pick.odds);
  return Number.isFinite(won) ? won : null;
}

// One row of the capper page's recent picks, at the /picks ledger's type scale: the league's
// badge, the matchup over the pick's line, then the result - the units it returned and a
// WIN / LOSS pill. A pending pick keeps its grading buttons instead.
export function RecentPickRow({ pick }: { pick: CapperPageView["recentPicks"][number] }) {
  const result = pick.status === "PENDING" ? null : RESULT[pick.status];
  const units = unitsResult(pick);
  return (
    <div className="flex items-center gap-3 rounded-[10px] px-1.5 py-2.5 transition-colors hover:bg-foreground/[0.035]">
      <span
        className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-[var(--league)] text-[10px] font-semibold tracking-[0.02em] text-white dark:bg-[var(--league-dark)] dark:text-[#0B1220]"
        style={leagueColorVars(pick.sport)}
      >
        {pick.sport}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {pick.awayTeam} @ {pick.homeTeam}
        </div>
        <div className="mt-0.5 truncate text-xs tabular-nums text-[#5B6275] dark:text-muted-foreground">
          {[
            formatPickLabel(pick.betDetail, pick.betType, pick.line) ?? betTypeLabel(pick.betType),
            (pick.odds > 0 ? "+" : "") + pick.odds,
            pick.units + "u",
            formatEastern(pick.gameTime, { month: "short", day: "numeric" }),
          ].join(" · ")}
        </div>
      </div>
      {result ? (
        <div className="flex flex-none items-center gap-2.5">
          {units !== null && <span className={"text-sm font-semibold tabular-nums " + result.units}>{formatSignedUnits(units, 2)}</span>}
          <span className={PILL + result.pill}>{result.label}</span>
        </div>
      ) : (
        <div className="flex-none">
          <PickStatusButtons pickId={pick.id} status={pick.status} />
        </div>
      )}
    </div>
  );
}
