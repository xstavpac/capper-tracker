import Link from "next/link";
import type { LeaderboardEntry, FavoriteCappersSummary } from "@/server/data/cappers";
import type { CapperSparkline as Series } from "@/server/data/cappers-page-aggregates";
import { RANKING_MIN_SAMPLE } from "@/server/data/stats";
import { PAGE_SIZE, cappersHref, type CappersParams } from "@/lib/cappers-page-params";
import { CapperSparkline, sparklineLabel } from "@/components/dashboard/capper-sparkline";
import { CappersLeaderboardControls, FavoritesToggle } from "@/components/dashboard/cappers-leaderboard-controls";
import { CappersSearch } from "@/components/dashboard/cappers-search";
import { CapperForm } from "@/components/dashboard/capper-form";
import { ClickableRow } from "@/components/dashboard/clickable-row";
import { FavoriteStar } from "@/components/dashboard/favorite-star";
import { formatRecord } from "@/components/dashboard/top-cappers";

const GREEN = "text-emerald-600 dark:text-emerald-400";
const RED = "text-red-600 dark:text-red-400";
const LABEL_TONE = { up: GREEN, down: RED, flat: "text-muted-foreground" } as const;
const signColor = (n: number) => (n >= 0 ? GREEN : RED);
const signed = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n);

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={"rounded-full px-2 py-0.5 text-[11px] font-medium " + className}>{children}</span>;
}

function Badges({ entry }: { entry: LeaderboardEntry }) {
  const { wins, losses, pushes, currentStreak } = entry.stats;
  const n = wins + losses + pushes;
  const smallSample = n > 0 && n < RANKING_MIN_SAMPLE;
  const streak = currentStreak.count >= 2 ? currentStreak : null;
  if (!entry.specialist && !smallSample && !streak) return null;
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1">
      {streak?.type === "WIN" && <Pill className="bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">hot {streak.count}</Pill>}
      {streak?.type === "LOSS" && <Pill className="bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">cold {streak.count}</Pill>}
      {smallSample && (
        <Pill className="bg-muted text-muted-foreground">
          {n} pick{n === 1 ? "" : "s"} &middot; small sample
        </Pill>
      )}
      {entry.specialist && <Pill className="bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">{entry.specialist.label}</Pill>}
    </span>
  );
}

function pageList(current: number, last: number): (number | "gap")[] {
  const set = new Set([1, last, current - 1, current, current + 1]);
  const nums = Array.from(set).filter((p) => p >= 1 && p <= last).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  nums.forEach((p, i) => {
    if (i > 0 && p - nums[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

function Pagination({ params, page, last }: { params: CappersParams; page: number; last: number }) {
  const base = "flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-sm";
  const nav = (label: string, target: number, disabled: boolean) =>
    disabled ? (
      <span className={base + " text-muted-foreground/40"} aria-hidden="true">
        {label}
      </span>
    ) : (
      <Link href={cappersHref(params, { page: target })} scroll={false} className={base + " text-muted-foreground hover:bg-muted hover:text-foreground"}>
        {label}
      </Link>
    );
  return (
    <nav aria-label="Pagination" className="flex items-center gap-1">
      {nav("‹", page - 1, page <= 1)}
      {pageList(page, last).map((p, i) =>
        p === "gap" ? (
          <span key={"gap" + i} className={base + " text-muted-foreground"}>
            &hellip;
          </span>
        ) : (
          <Link
            key={p}
            href={cappersHref(params, { page: p })}
            scroll={false}
            aria-current={p === page ? "page" : undefined}
            className={base + " font-medium " + (p === page ? "bg-brand-600 text-white" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
          >
            {p}
          </Link>
        )
      )}
      {nav("›", page + 1, page >= last)}
    </nav>
  );
}

export function CappersLeaderboardCard({
  rows,
  total,
  params,
  leagues,
  sparklines,
  favSummary,
}: {
  // The current page's rows only (already filtered and sorted).
  rows: LeaderboardEntry[];
  total: number;
  params: CappersParams;
  leagues: string[];
  sparklines: Map<string, Series>;
  favSummary: FavoriteCappersSummary | null;
}) {
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(params.page, last);
  const first = (page - 1) * PAGE_SIZE;

  return (
    <div id="leaderboard" className="scroll-mt-4 rounded-card bg-card p-5 shadow-soft">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground max-sm:w-full">Capper leaderboard</h2>
        {/* Phone only: the search and the Add control, which the banner carries from `sm` up. The
            open form takes the row under the search. */}
        <div className="flex w-full flex-wrap items-center gap-2 sm:hidden">
          <CappersSearch params={params} variant="leaderboard" />
          <CapperForm atLimit={false} triggerLabel="+ Add" triggerClassName="h-11 shrink-0 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white transition hover:bg-brand-700" />
        </div>
        <FavoritesToggle params={params} />
      </div>

      <CappersLeaderboardControls params={params} leagues={leagues} />

      {params.fav && (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-muted px-4 py-2.5 text-sm">
          <span className="font-medium text-foreground">Favorites combined</span>
          {favSummary ? (
            <>
              <span className="text-muted-foreground">
                Record <span className="font-medium text-foreground">{formatRecord(favSummary.collectiveStats)}</span>
              </span>
              <span className="text-muted-foreground">
                ROI <span className={"font-medium " + signColor(favSummary.collectiveStats.roi)}>{signed(favSummary.collectiveStats.roi)}%</span>
              </span>
              <span className="text-muted-foreground">
                Net units <span className={"font-medium " + signColor(favSummary.collectiveStats.netUnits)}>{signed(favSummary.collectiveStats.netUnits)}u</span>
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">No favorites yet &mdash; star a capper to add them.</span>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {params.fav && !favSummary ? "You haven't favorited any cappers yet." : "No cappers match these filters."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] max-[480px]:min-w-0 border-collapse text-sm max-[480px]:text-xs">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th className="w-10 max-[480px]:w-6 px-3 py-2 max-[480px]:px-1">#</th>
                <th className="px-3 py-2 max-[480px]:px-1">Capper</th>
                <th className="px-3 py-2 max-[480px]:hidden">Last 20</th>
                <th className="px-3 py-2 max-[480px]:hidden">Record</th>
                <th className="px-3 py-2 max-[480px]:px-1">Win</th>
                <th className="px-3 py-2 max-[480px]:px-1">ROI</th>
                <th className="px-3 py-2 max-[480px]:px-1">Units</th>
                <th className="w-8 px-3 py-2 max-[480px]:px-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => {
                const href = "/cappers/" + e.capperId;
                const series = sparklines.get(e.capperId);
                const label = sparklineLabel(series);
                return (
                  <ClickableRow key={e.capperId} href={href}>
                    <td className="px-3 py-2 max-[480px]:px-1 text-muted-foreground">{first + i + 1}</td>
                    <td className="px-3 py-2 max-[480px]:max-w-[7.5rem] max-[480px]:px-1">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Link href={href} className="truncate font-medium text-foreground hover:underline">
                            {e.name}
                          </Link>
                          <FavoriteStar capperId={e.capperId} isFavorite={e.isFavorite} />
                        </div>
                        <Badges entry={e} />
                      </div>
                    </td>
                    <td className="px-3 py-2 max-[480px]:hidden">
                      <div className="w-20">
                        <CapperSparkline series={series} width={80} height={20} className="block" />
                        {label && <div className={"mt-0.5 text-[10px] leading-none " + LABEL_TONE[label.tone]}>{label.text}</div>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 max-[480px]:hidden text-muted-foreground">{formatRecord(e.stats)}</td>
                    <td className="px-3 py-2 max-[480px]:px-1 font-medium text-foreground">{Math.round(e.stats.winPct)}%</td>
                    <td className={"whitespace-nowrap px-3 py-2 max-[480px]:px-1 font-medium " + signColor(e.stats.roi)}>{signed(e.stats.roi)}%</td>
                    <td className={"whitespace-nowrap px-3 py-2 max-[480px]:px-1 font-medium " + signColor(e.stats.netUnits)}>{signed(e.stats.netUnits)}u</td>
                    <td className="px-3 py-2 max-[480px]:px-1 text-muted-foreground">
                      <Link href={href} aria-label={"Open " + e.name} className="block hover:text-foreground">
                        &rsaquo;
                      </Link>
                    </td>
                  </ClickableRow>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
          <p className="text-sm text-muted-foreground">
            Showing {first + 1}&ndash;{first + rows.length} of {total} capper{total === 1 ? "" : "s"}
          </p>
          {last > 1 && <Pagination params={params} page={page} last={last} />}
        </div>
      )}
    </div>
  );
}
