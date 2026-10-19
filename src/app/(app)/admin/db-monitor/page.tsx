import { requireAdminOpsPage } from "@/server/admin-gate";
import { loadDbMonitorSnapshot } from "@/server/data/db-monitor";
import {
  buildMonitorView,
  formatAvg,
  formatClaudeReport,
  formatDuration,
  formatMb,
  formatNumber,
  parseRowThreshold,
} from "@/lib/db-monitor";
import { CopyReportButton, ResetStatsButton } from "@/components/admin/db-monitor-controls";

// pg_stat_statements for runaway queries, admin-only (requireAdminOpsPage).
// One monitor statement per load (loadDbMonitorSnapshot), read fresh for each
// request - no cache, no polling; reload to refresh. The row threshold is a
// plain GET form like the skipped-lines date filter.
export default async function DbMonitorPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireAdminOpsPage();
  const threshold = parseRowThreshold(searchParams.threshold);
  const result = await loadDbMonitorSnapshot();

  if (!result.ok) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">DB Monitor</h1>
        <p className="text-sm text-muted-foreground">
          pg_stat_statements couldn&apos;t be read on this database: <span className="font-mono">{result.reason}</span>
        </p>
      </div>
    );
  }

  const view = buildMonitorView(result.snapshot, threshold, new Date());
  const report = formatClaudeReport(view);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">DB Monitor</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Statements touching public tables, top {view.rows.length} by rows returned. Reload to refresh.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyReportButton report={report} />
          <ResetStatsButton />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <Stat label="Since last reset" value={view.sinceResetMs !== null ? formatDuration(view.sinceResetMs) : "unknown"} hint={view.statsReset ? view.statsReset.toISOString().slice(0, 16).replace("T", " ") + " UTC" : undefined} />
        <Stat label="Rows, all statements" value={formatNumber(view.totalRows)} hint={`${formatNumber(view.statementCount)} statements`} />
        <Stat label="Est. transfer, top list" value={"~" + formatMb(view.estBytesTop)} hint="Estimate: rows × approx row width per table" />
        <Stat label="Flagged" value={`${view.flaggedCount} of ${view.rows.length}`} hint={`Threshold ${formatNumber(view.threshold)} avg rows/call`} alert={view.flaggedCount > 0} />
      </dl>

      {view.dealloc > 0 && (
        <p className="text-sm text-[#B4470F] dark:text-[#F29A6B]">
          {formatNumber(view.dealloc)} statement entries were evicted since the reset, so these totals undercount.
        </p>
      )}

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-muted-foreground">
          Flag above (avg rows/call)
          <input type="number" min={1} step={1} name="threshold" defaultValue={view.threshold} className="w-32 rounded-md border border-border bg-background px-2 py-1 text-foreground" />
        </label>
        <button type="submit" className="rounded-md border border-border bg-muted px-3 py-1 text-foreground hover:bg-muted/70">
          Apply
        </button>
      </form>

      {view.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No statements touching public tables recorded since the last reset.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Statement</th>
                <th className="py-2 pr-3 text-right font-medium">Calls</th>
                <th className="py-2 pr-3 text-right font-medium">Rows</th>
                <th className="py-2 pr-3 text-right font-medium">Avg rows</th>
                <th className="py-2 text-right font-medium">Exec ms</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.queryid} className={`border-b border-border-subtle align-top ${r.flags.length ? "bg-[#FDECEC] dark:bg-[#DC2626]/15" : ""}`}>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-foreground">{r.label ?? <span className="text-muted-foreground">Unlabeled</span>}</div>
                    {r.flags.map((f) => (
                      <div key={f.code} className="mt-0.5 text-xs font-medium text-[#B91C1C] dark:text-[#F87171]">
                        {f.reason}
                      </div>
                    ))}
                    <pre className="mt-1 max-w-[60ch] whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground md:max-w-none">{r.text}</pre>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-foreground">{formatNumber(r.calls)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-foreground">{formatNumber(r.rows)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-foreground">{formatAvg(r.avgRows)}</td>
                  <td className="py-2 text-right tabular-nums text-foreground">{formatNumber(r.totalExecMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Report text (what &quot;Copy for Claude&quot; copies)</summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-muted p-3 font-mono text-xs text-foreground">{report}</pre>
      </details>
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
