import { requireAdminOpsPage } from "@/server/admin-gate";
import { loadLatestCronRuns, loadRecentCronRuns } from "@/server/data/cron-runs";
import { CRON_JOBS, cronHealth, cronsReport, describeSchedule, formatAgo, type CronRunRow } from "@/lib/cron-runs";
import { formatAdminReport } from "@/lib/admin-report";
import { CopyReportButton, ReportDetails } from "@/components/admin/report-controls";

// Cron health from cron_runs, admin-only (requireAdminOpsPage). Two small
// statements per load - each cron's newest run, and its last 10 in 7 days -
// read fresh; no cache, no polling. Reload to refresh.
export default async function CronsPage() {
  await requireAdminOpsPage();
  const [latest, recent] = await Promise.all([loadLatestCronRuns(), loadRecentCronRuns()]);
  const now = new Date();
  const health = CRON_JOBS.map((job) => cronHealth(job, latest.find((r) => r.name === job.name) ?? null, now));
  const report = formatAdminReport(cronsReport(health, recent, now));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Crons</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every authorized run of each Vercel cron (one cron_runs row each). Red: failed, timed out, or overdue past its grace. Reload to refresh.
          </p>
        </div>
        <CopyReportButton report={report} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Cron</th>
              <th className="py-2 pr-3 font-medium">Last run</th>
              <th className="py-2 pr-3 text-right font-medium">Duration</th>
              <th className="py-2 pr-3 text-right font-medium">Rows</th>
              <th className="py-2 font-medium">Recent (newest first)</th>
            </tr>
          </thead>
          <tbody>
            {health.map((h) => {
              const runs = recent.filter((r) => r.name === h.job.name);
              return (
                <tr key={h.job.name} className={`border-b border-border-subtle align-top ${h.problem ? "bg-[#FDECEC] dark:bg-[#DC2626]/15" : ""}`}>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-foreground">{h.job.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {describeSchedule(h.job.schedule)} · {h.job.what}
                    </div>
                    {h.problem && <div className="mt-0.5 text-xs font-medium text-[#B91C1C] dark:text-[#F87171]">{h.problem}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    {h.latest ? (
                      <>
                        <StatusBadge status={h.latest.status} />{" "}
                        <span className="text-foreground">{formatAgo(now.getTime() - h.latest.startedAt.getTime())} ago</span>
                        {h.latest.httpStatus !== null && <span className="text-xs text-muted-foreground"> · HTTP {h.latest.httpStatus}</span>}
                        {h.latest.summary && (
                          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                            {Object.entries(h.latest.summary)
                              .map(([k, v]) => `${k}=${v}`)
                              .join(" ")}
                          </div>
                        )}
                        {h.latest.error && <div className="mt-0.5 font-mono text-xs text-[#B91C1C] dark:text-[#F87171]">{h.latest.error}</div>}
                      </>
                    ) : (
                      <span className="text-muted-foreground">No runs logged yet</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-foreground">{h.latest?.durationMs != null ? `${(h.latest.durationMs / 1000).toFixed(1)}s` : "-"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-foreground">{h.latest?.rowsTouched ?? "-"}</td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      {runs.map((r) => (
                        <span key={r.startedAt.toISOString()} title={`${r.startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`}>
                          <StatusBadge status={r.status} />
                        </span>
                      ))}
                      {runs.length === 0 && <span className="text-muted-foreground">-</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ReportDetails report={report} />
    </div>
  );
}

const BADGE: Record<CronRunRow["status"], string> = {
  OK: "bg-[#DCFCE7] text-[#166534] dark:bg-[#166534]/30 dark:text-[#86EFAC]",
  WARNING: "bg-[#FEF3C7] text-[#92400E] dark:bg-[#92400E]/30 dark:text-[#FCD34D]",
  ERROR: "bg-[#FDECEC] text-[#B91C1C] dark:bg-[#DC2626]/20 dark:text-[#F87171]",
  RUNNING: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: CronRunRow["status"] }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${BADGE[status]}`}>{status}</span>;
}
