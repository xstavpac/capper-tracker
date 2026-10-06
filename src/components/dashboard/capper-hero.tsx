import type { ReactNode } from "react";
import { StreakBadge } from "@/components/dashboard/capper-panels";
import { formatEastern, formatRelativeTime } from "@/lib/dates";
import { formatSignedUnits } from "@/lib/units-extremes";
import { getRecordColor, winPctOf, type CategoryBreakdownItem, type MomentumBreakdown, type MomentumRow } from "@/server/data/stats";
import type { CapperRecordView } from "@/server/data/capper-detail";

type Streak = { type: "WIN" | "LOSS" | "NONE"; count: number };

const UP = "text-[#34D399]";
const DOWN = "text-[#FCA5A5]";

// The bucket the capper's actual current streak falls into - e.g. currently on
// a 5-game loss streak is the "After 4+ L" row (5 collapses into the same 4+
// bucket the row itself represents). Undefined when currentStreak.type is
// "NONE" (no decided picks yet).
function currentStreakRow(breakdown: MomentumBreakdown, currentStreak: Streak): MomentumRow | undefined {
  if (currentStreak.type === "NONE" || currentStreak.count === 0) return undefined;
  const length = currentStreak.count >= 4 ? "4+" : String(currentStreak.count);
  return (currentStreak.type === "WIN" ? breakdown.afterWin : breakdown.afterLoss).find((row) => row.length === length);
}

function MomentumBox({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const box = tone === "up" ? "bg-[rgba(16,185,129,0.14)]" : tone === "down" ? "bg-[rgba(239,68,68,0.14)]" : "bg-white/[0.06]";
  const text = tone === "up" ? "text-[#6EE7B7]" : tone === "down" ? "text-[#FCA5A5]" : "text-white";
  return (
    <div className={"min-w-0 rounded-xl px-3 py-2.5 " + box}>
      <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-white/60">{label}</div>
      <div className={"mt-0.5 truncate text-[17px] font-extrabold tabular-nums " + text}>{value}</div>
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
    <div className="w-full rounded-[18px] border border-white/[0.12] bg-white/[0.06] p-4 sm:w-auto sm:min-w-[260px] sm:flex-[0_1_340px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/60">Momentum</span>
          {row && hasHistory && (
            <span className="truncate text-xl font-extrabold leading-none">
              After {row.length} {currentStreak.type === "WIN" ? "W" : "L"}
            </span>
          )}
        </div>
        {row && hasHistory && (
          <span className="flex-none rounded-full bg-[#2563EB] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.08em] text-white">Current</span>
        )}
      </div>
      {row && hasHistory ? (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <MomentumBox label="Record" value={row.wins + "-" + row.losses} />
          <MomentumBox label="Hit" value={Math.round(row.winPct) + "%"} tone={getRecordColor(row.winPct) === "green" ? "up" : "down"} />
          <MomentumBox label="Units" value={formatSignedUnits(row.netUnits, 2)} tone={row.netUnits >= 0 ? "up" : "down"} />
        </div>
      ) : (
        <p className="mt-3 text-sm text-white/70">Not enough history yet</p>
      )}
      <p className="mt-2.5 text-[11px] font-medium text-white/50">All sports · All time</p>
    </div>
  );
}

// `wraps` is for a value made of words (the best market's name): it is set a size down and breaks
// onto a second line rather than being cut off.
function StatCell({ label, value, sub, tone, wraps, className = "" }: { label: string; value: ReactNode; sub?: string; tone?: "up" | "down"; wraps?: boolean; className?: string }) {
  return (
    <div className={"min-w-0 bg-[#101F47] px-4 py-4 sm:px-5 " + className}>
      <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/55">{label}</div>
      <div
        className={
          "mt-1 font-extrabold leading-tight tabular-nums " +
          (wraps ? "text-xl sm:text-[22px] " : "truncate text-[22px] sm:text-[28px] ") +
          (tone === "up" ? UP : tone === "down" ? DOWN : "text-white")
        }
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11px] font-medium tabular-nums text-white/55">{sub}</div>}
    </div>
  );
}

function TrendIcon({ up }: { up: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      {up ? <path d="M3 17l6-6 4 4 8-8M15 7h6v6" /> : <path d="M3 7l6 6 4-4 8 8M15 17h6v-6" />}
    </svg>
  );
}

// The capper page's banner: who the capper is, the record of the page's sport + time selection
// (`summary`, with the win % drawn as the avatar's ring), and their momentum. Dark in both themes,
// like the /cappers and /dashboard banners. Its layout follows the card's own width (a size
// container), not the screen's: the sidebar makes the card far narrower than the screen.
export function CapperHero({
  name,
  initials,
  color,
  summary,
  currentStreak,
  momentum,
  bestMarket,
  sports,
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
  sports: string[];
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
    <div className="relative overflow-hidden rounded-3xl bg-[#0B1736] p-5 text-white shadow-[0_10px_28px_rgba(3,11,41,0.28)] [container-type:inline-size] sm:px-8 sm:py-7">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_90%_at_100%_0%,rgba(59,130,246,0.35),transparent_70%),radial-gradient(45%_70%_at_0%_100%,rgba(16,185,129,0.16),transparent_70%)]"
      />
      <div className="relative flex flex-wrap items-center justify-between gap-6">
        <div className="flex min-w-0 items-center gap-4 sm:gap-[22px]">
          <div className="relative flex-none">
            <div
              className="h-20 w-20 rounded-full p-[5px] sm:h-[104px] sm:w-[104px] sm:p-[6px]"
              style={{ background: `conic-gradient(#10B981 ${graded ? winPct : 0}%, rgba(255,255,255,0.14) 0)` }}
            >
              <div
                className={
                  "flex h-full w-full items-center justify-center rounded-full border-4 border-[#0B1736] font-extrabold text-white " +
                  (initials.length > 3 ? "text-lg sm:text-[22px]" : initials.length > 2 ? "text-[22px] sm:text-[28px]" : "text-[26px] sm:text-[34px]")
                }
                style={{ backgroundColor: color }}
              >
                {initials}
              </div>
            </div>
            <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#10B981] px-2.5 py-0.5 text-xs font-extrabold tabular-nums text-[#052E1B]">
              <span className="sr-only">Win rate </span>
              {winPctText}
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="min-w-0 break-words text-[28px] font-extrabold leading-none sm:text-[42px]">{name}</h1>
              {summary.netUnits !== 0 && (
                <span
                  className={
                    "inline-flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold " +
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
              <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] tabular-nums text-white/[0.72]">
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
            {sports.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {sports.map((s) => (
                  <span key={s} className="rounded-[7px] border border-white/[0.14] bg-white/[0.08] px-2 py-1 text-[11px] font-extrabold uppercase leading-none tracking-[0.06em]">
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <MomentumCard breakdown={momentum} currentStreak={currentStreak} />
      </div>

      {/* The dividers are the grid's 1px gaps over the container's wash. The last cell fills its row. */}
      <div className="relative mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-white/10 [@container_(min-width:560px)]:grid-cols-3 [@container_(min-width:900px)]:grid-cols-5">
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
