import type { ReactNode } from "react";
import { StreakBadge } from "@/components/dashboard/capper-panels";
import { formatEastern, formatRelativeTime } from "@/lib/dates";
import { formatSignedUnits } from "@/lib/units-extremes";
import { getRecordColor, winPctOf, type CategoryBreakdownItem, type MomentumBreakdown, type MomentumRow } from "@/server/data/stats";
import type { CapperRecordView } from "@/server/data/capper-detail";

type Streak = { type: "WIN" | "LOSS" | "NONE"; count: number };

const UP = "text-[#34D399]";
const DOWN = "text-[#FCA5A5]";
const LABEL = "font-medium uppercase tracking-[0.08em] text-white/60";

// The bucket the capper's actual current streak falls into - e.g. currently on
// a 5-game loss streak is the "After 4+ L" row (5 collapses into the same 4+
// bucket the row itself represents). Undefined when currentStreak.type is
// "NONE" (no decided picks yet).
function currentStreakRow(breakdown: MomentumBreakdown, currentStreak: Streak): MomentumRow | undefined {
  if (currentStreak.type === "NONE" || currentStreak.count === 0) return undefined;
  const length = currentStreak.count >= 4 ? "4+" : String(currentStreak.count);
  return (currentStreak.type === "WIN" ? breakdown.afterWin : breakdown.afterLoss).find((row) => row.length === length);
}

function MomentumStat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="min-w-0">
      <dt className={"text-[10px] " + LABEL}>{label}</dt>
      <dd className={"truncate text-[15px] font-semibold leading-tight tabular-nums " + (tone === "up" ? UP : tone === "down" ? DOWN : "text-white")}>{value}</dd>
    </div>
  );
}

// "What does history say about right now": the capper's record on the pick
// immediately following a streak like the one they are on (see computeMomentum
// in server/data/stats.ts) - that one bucket only. Always all sports, all time,
// whatever the page's filters say.
function MomentumCard({ breakdown, currentStreak }: { breakdown: MomentumBreakdown; currentStreak: Streak }) {
  const row = currentStreakRow(breakdown, currentStreak);
  // No minimum sample here (unlike the rankings' RANKING_MIN_SAMPLE): one decided pick in the
  // bucket is enough to show its real record.
  const hasHistory = row !== undefined && row.sampleSize > 0;
  return (
    <div className="flex w-full flex-col gap-1 rounded-[14px] border border-white/[0.12] bg-white/[0.06] px-3.5 py-2 sm:w-auto sm:min-w-[240px]">
      <div className="flex items-center justify-between gap-4">
        <p className={"min-w-0 truncate text-[11px] " + LABEL}>
          Momentum
          {row && hasHistory && (
            <span className="text-[13px] font-semibold normal-case tracking-normal text-white">
              {" · After " + row.length + " " + (currentStreak.type === "WIN" ? "W" : "L")}
            </span>
          )}
        </p>
        {row && hasHistory && (
          <span className="flex-none rounded-full bg-[#2563EB] px-2 py-0.5 text-[10px] font-semibold uppercase leading-4 tracking-[0.08em] text-white">Current</span>
        )}
      </div>
      {row && hasHistory ? (
        <dl className="grid grid-cols-3 gap-4">
          <MomentumStat label="Record" value={row.wins + "-" + row.losses} />
          <MomentumStat label="Hit" value={Math.round(row.winPct) + "%"} tone={getRecordColor(row.winPct) === "green" ? "up" : "down"} />
          <MomentumStat label="Units" value={formatSignedUnits(row.netUnits, 2)} tone={row.netUnits >= 0 ? "up" : "down"} />
        </dl>
      ) : (
        <p className="text-[13px] text-white/70">Not enough history yet</p>
      )}
    </div>
  );
}

// `wraps` is for a value made of words (the best market's name): it breaks onto a second line
// rather than being cut off.
function StatCell({ label, value, sub, tone, wraps, className = "" }: { label: string; value: ReactNode; sub?: string; tone?: "up" | "down"; wraps?: boolean; className?: string }) {
  return (
    // The banner's navy under the same faint white wash as the momentum card (opaque, to cover the grid's own).
    <div className={"min-w-0 bg-banner bg-[linear-gradient(rgb(255_255_255/0.06),rgb(255_255_255/0.06))] px-4 py-[9px] " + className}>
      <div className={"text-[11px] " + LABEL}>{label}</div>
      <div className={"mt-0.5 text-xl font-semibold leading-tight tabular-nums " + (wraps ? "" : "truncate ") + (tone === "up" ? UP : tone === "down" ? DOWN : "text-white")}>{value}</div>
      {sub && <div className="truncate text-xs tabular-nums text-white/60">{sub}</div>}
    </div>
  );
}

function TrendIcon({ up }: { up: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      {up ? <path d="M3 17l6-6 4 4 8-8M15 7h6v6" /> : <path d="M3 7l6 6 4-4 8 8M15 17h6v-6" />}
    </svg>
  );
}

// The capper page's banner: who the capper is, the record of the page's sport + time selection
// (`summary`, with the win % drawn as the avatar's ring), and their momentum. One flat navy, dark
// in both themes, like the /cappers and /live banners. Its layout follows the card's own width (a
// size container), not the screen's: the sidebar makes the card far narrower than the screen.
export function CapperHero({
  name,
  initials,
  color,
  summary,
  currentStreak,
  momentum,
  bestMarket,
  trackedSinceMs,
  lastPickMs,
  pickCount,
  pendingCount,
  nowMs,
}: {
  name: string;
  initials: string;
  color: string;
  summary: CapperRecordView;
  currentStreak: Streak;
  momentum: MomentumBreakdown;
  bestMarket: CategoryBreakdownItem | null;
  trackedSinceMs: number | null;
  lastPickMs: number | null;
  pickCount: number;
  pendingCount: number;
  nowMs: number;
}) {
  const graded = summary.wins + summary.losses > 0;
  const winPct = winPctOf(summary.wins, summary.losses);
  const winPctText = graded ? winPct.toFixed(1) + "%" : "—";
  const bestGraded = bestMarket !== null && bestMarket.wins + bestMarket.losses > 0;

  return (
    <div className="rounded-[18px] bg-banner px-3.5 py-3.5 text-white shadow-[0_8px_24px_rgba(3,11,41,0.22)] [container-type:inline-size] sm:px-[22px]">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-4">
          <div className="relative flex-none">
            <div className="h-16 w-16 rounded-full p-[5px]" style={{ background: `conic-gradient(#10B981 ${graded ? winPct : 0}%, rgba(255,255,255,0.14) 0)` }}>
              <div
                className={
                  "flex h-full w-full items-center justify-center rounded-full border-[3px] border-banner font-bold text-white " +
                  (initials.length > 3 ? "text-xs" : initials.length > 2 ? "text-[15px]" : "text-[19px]")
                }
                style={{ backgroundColor: color }}
              >
                {initials}
              </div>
            </div>
            <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#10B981] px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-[#052E1B]">
              <span className="sr-only">Win rate </span>
              {winPctText}
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="min-w-0 break-words text-2xl font-bold leading-tight tracking-[-0.01em]">{name}</h1>
              {summary.netUnits !== 0 && (
                <span
                  className={
                    "inline-flex flex-none items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium " +
                    (summary.netUnits > 0 ? "bg-[rgba(16,185,129,0.16)] text-[#6EE7B7]" : "bg-[rgba(239,68,68,0.16)] text-[#FCA5A5]")
                  }
                >
                  <TrendIcon up={summary.netUnits > 0} />
                  {summary.netUnits > 0 ? "In profit" : "In the red"}
                </span>
              )}
              {/* On the navy card in both themes, so the badge always wears its dark-theme colors. */}
              <span className="dark contents">
                <StreakBadge streak={currentStreak} />
              </span>
            </div>
            {trackedSinceMs !== null && lastPickMs !== null && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] tabular-nums text-white/[0.72]">
                <span>Tracked since {formatEastern(new Date(trackedSinceMs), { month: "short", day: "numeric" })}</span>
                <span aria-hidden className="max-sm:hidden">•</span>
                <span>
                  {pickCount} {pickCount === 1 ? "pick" : "picks"} · {pendingCount} pending
                </span>
                <span aria-hidden className="max-sm:hidden">•</span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#10B981]" />
                  Last pick {formatRelativeTime(new Date(lastPickMs), nowMs)}
                </span>
              </p>
            )}
          </div>
        </div>
        <MomentumCard breakdown={momentum} currentStreak={currentStreak} />
      </div>

      {/* The dividers are the grid's 1px gaps over the container's wash. The last cell fills its row. */}
      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-white/[0.14] [@container_(min-width:560px)]:grid-cols-3 [@container_(min-width:900px)]:grid-cols-5">
        <StatCell label="Record" value={summary.wins + "-" + summary.losses + "-" + summary.pushes} />
        <StatCell label="Win rate" value={winPctText} />
        <StatCell label="ROI" value={(summary.roi > 0 ? "+" : summary.roi < 0 ? "−" : "") + Math.abs(summary.roi) + "%"} tone={summary.roi >= 0 ? "up" : "down"} />
        <StatCell label="Net units" value={(summary.netUnits > 0 ? "+" : summary.netUnits < 0 ? "−" : "") + Math.abs(summary.netUnits) + "u"} tone={summary.netUnits >= 0 ? "up" : "down"} />
        <StatCell
          className="col-span-2 [@container_(min-width:900px)]:col-span-1"
          label="Best market"
          wraps
          value={bestMarket ? bestMarket.label + (bestGraded ? " " + Math.round(bestMarket.winPct) + "%" : "") : "—"}
          sub={bestMarket ? bestMarket.wins + "-" + bestMarket.losses + (bestMarket.pushes > 0 ? "-" + bestMarket.pushes : "") + " · " + bestMarket.count + " graded" : undefined}
        />
      </div>
    </div>
  );
}
