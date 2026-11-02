import Link from "next/link";
import { requireAdminOpsPage } from "@/server/admin-gate";
import { loadRecentRuns, loadRun, RUN_LIST_LIMIT } from "@/server/data/generator-runs-view";
import { formatAdminReport } from "@/lib/admin-report";
import { modeLabel, runsReport, type RunRow } from "@/lib/parlay/run-view";
import { CopyReportButton, ReportDetails } from "@/components/admin/report-controls";
import { RunDetailView, RunsList } from "@/components/admin/generator-runs";

// The Parlay Generator's run log, admin-only (requireAdminOpsPage): the newest runs with their
// funnel (a count and the reasons for the drop at each stage - red where a stage collapsed to 0,
// amber at exactly 50 / 100 / 1000), the dropped-pick reasons, errors, and Hybrid's FanDuel line
// status. One run opens in full (?run=<id>): Hedge / Contrarian leg by leg and every dropped pick.
// Written by the generator (lib/parlay/run-trace.ts, server/data/generator-runs.ts); this page only
// reads, fresh, with no cache and no polling. Reload to refresh.
const MODES = ["STANDARD", "YOUR_PICKS", "HYBRID"] as const;

export default async function GeneratorRunsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  await requireAdminOpsPage();
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const runId = one(searchParams.run);

  if (runId) {
    const run = await loadRun(runId);
    return (
      <div className="space-y-6">
        <Link href="/admin/generator" className="text-sm text-foreground underline underline-offset-2">
          ← All runs
        </Link>
        {run ? <RunDetailView run={run} /> : <p className="text-sm text-muted-foreground">No such run (it may have been cleared).</p>}
      </div>
    );
  }

  const mode = MODES.find((m) => m === one(searchParams.mode));
  const runs: RunRow[] = await loadRecentRuns({ mode });
  const report = formatAdminReport(runsReport(runs));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Generator</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The last {RUN_LIST_LIMIT} runs{mode ? ` (${modeLabel(mode)})` : ""}, all users: how many picks survive each stage and why the rest were dropped. Red: a stage that collapsed to 0, or an error. Amber: a count of exactly
            50, 100 or 1000. Counts are kept about 180 days, per-pick detail about 30. Reload to refresh.
          </p>
          <p className="mt-2 flex flex-wrap gap-3 text-sm">
            <Link href="/admin/generator" className={mode ? "text-muted-foreground underline underline-offset-2" : "font-medium text-foreground"}>
              All
            </Link>
            {MODES.map((m) => (
              <Link key={m} href={`/admin/generator?mode=${m}`} className={mode === m ? "font-medium text-foreground" : "text-muted-foreground underline underline-offset-2"}>
                {modeLabel(m)}
              </Link>
            ))}
          </p>
        </div>
        <CopyReportButton report={report} />
      </div>

      <RunsList runs={runs} />
      <ReportDetails report={report} />
    </div>
  );
}
