import { requireAdminOpsPage } from "@/server/admin-gate";
import { loadOddsApiView } from "@/server/data/odds-api-status";
import { creditPct, creditsProblem, oddsApiReport, staleProblem } from "@/lib/odds-api-status";
import { formatAgo } from "@/lib/cron-runs";
import { formatAdminReport } from "@/lib/admin-report";
import { CopyReportButton, ReportDetails } from "@/components/admin/report-controls";

// Odds API credits, calls and snapshot freshness, admin-only
// (requireAdminOpsPage). One statement per load (loadOddsApiView), read
// fresh; no cache, no polling. Reload to refresh.
export default async function OddsApiPage() {
  await requireAdminOpsPage();
  const view = await loadOddsApiView();
  const report = formatAdminReport(oddsApiReport(view));
  const pct = creditPct(view.latest);
  const credits = creditsProblem(view.latest);
  const stale = staleProblem(view.snapshots, view.now);
  const totalToday = view.callsToday.reduce((a, c) => a + c.calls, 0);
  const sports = Array.from(new Set(view.callsToday.map((c) => c.sportKey)));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Odds API</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Credits from the x-requests-used / x-requests-remaining headers on each call (odds_api_usage_log), and each sport&apos;s latest odds snapshot. Reload to refresh.
          </p>
        </div>
        <CopyReportButton report={report} />
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <Stat label="Credits remaining" value={view.latest?.creditsRemaining?.toLocaleString("en-US") ?? "-"} hint={view.latest ? `as of ${formatAgo(view.now.getTime() - view.latest.pollTimestamp.getTime())} ago` : "no calls logged"} alert={!!credits} />
        <Stat label="Credits used" value={view.latest?.creditsUsed?.toLocaleString("en-US") ?? "-"} hint={pct !== null ? `${Math.round(pct * 100)}% of the month` : undefined} alert={!!credits} />
        <Stat label="Calls today (ET)" value={totalToday.toLocaleString("en-US")} hint={`${sports.length} sports`} />
        <Stat label="Calls this month" value={view.callsMonth.toLocaleString("en-US")} />
      </dl>

      {(credits || stale) && (
        <div className="space-y-1 text-sm font-medium text-[#B91C1C] dark:text-[#F87171]">
          {credits && <p>{credits}</p>}
          {stale && <p>{stale}</p>}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">Calls today by sport</h2>
        {view.callsToday.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Odds API calls logged today.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Sport</th>
                  <th className="py-2 pr-3 font-medium">Caller</th>
                  <th className="py-2 pr-3 font-medium">HTTP</th>
                  <th className="py-2 text-right font-medium">Calls</th>
                </tr>
              </thead>
              <tbody>
                {view.callsToday.map((c) => (
                  <tr key={`${c.sportKey}|${c.caller}|${c.httpStatus}`} className={`border-b border-border-subtle ${c.httpStatus !== null && c.httpStatus >= 400 ? "bg-[#FDECEC] dark:bg-[#DC2626]/15" : ""}`}>
                    <td className="py-1.5 pr-3 text-foreground">{c.sportKey}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{c.caller ?? "not recorded"}</td>
                    <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{c.httpStatus ?? "-"}</td>
                    <td className="py-1.5 text-right tabular-nums text-foreground">{c.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">Latest odds snapshot per sport</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Sport</th>
                <th className="py-2 pr-3 font-medium">Covers (ET)</th>
                <th className="py-2 font-medium">Seeded</th>
              </tr>
            </thead>
            <tbody>
              {view.snapshots.map((s) => (
                <tr key={s.sportKey} className={`border-b border-border-subtle ${s.stale ? "bg-[#FDECEC] dark:bg-[#DC2626]/15" : ""}`}>
                  <td className="py-1.5 pr-3 text-foreground">
                    {s.sportKey}
                    {!s.inSeason && <span className="text-xs text-muted-foreground"> · off season</span>}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums text-foreground">{s.fetchDate ?? "-"}</td>
                  <td className="py-1.5 text-muted-foreground">{s.ageMs !== null ? `${formatAgo(s.ageMs)} ago` : "no snapshot rows"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <ReportDetails report={report} />
    </div>
  );
}

function Stat({ label, value, hint, alert = false }: { label: string; value: string; hint?: string; alert?: boolean }) {
  return (
    <div className="rounded-lg border border-border-subtle p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 text-lg font-semibold tabular-nums ${alert ? "text-[#B91C1C] dark:text-[#F87171]" : "text-foreground"}`}>{value}</dd>
      {hint && <dd className="mt-0.5 text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}
