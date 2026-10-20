import { requireAdminOpsPage } from "@/server/admin-gate";
import { loadGradingView } from "@/server/data/grading-health";
import { gradingReport, stuckSince } from "@/lib/grading-health";
import { GRADING_FUZZY_WINDOW_DAYS, GRADING_STUCK_AFTER_FINAL_HOURS, GRADING_STUCK_NO_RESULT_HOURS } from "@/lib/admin-thresholds";
import { formatAdminReport, shortId } from "@/lib/admin-report";
import { CopyReportButton, ReportDetails } from "@/components/admin/report-controls";

// Grading health, admin-only (requireAdminOpsPage): pending picks by sport,
// stuck pending with the last recorded grading-failure reason, and the
// fuzzy-graded count. One statement per load (loadGradingView), read fresh;
// no cache, no polling. Reload to refresh.
export default async function GradingPage() {
  await requireAdminOpsPage();
  const view = await loadGradingView();
  const report = formatAdminReport(gradingReport(view));
  const pending = view.bySport.reduce((a, s) => a + s.pending, 0);
  const pastLookback = view.bySport.reduce((a, s) => a + s.pastLookback, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Grading</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Stuck = still PENDING in an auto-graded sport, inside the {view.lookbackDays}-day regrade lookback, with its game final {GRADING_STUCK_AFTER_FINAL_HOURS}h+ ago (or no final found {GRADING_STUCK_NO_RESULT_HOURS}h+ after it started). Reload to refresh.
          </p>
        </div>
        <CopyReportButton report={report} />
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <Stat label="Pending" value={pending} hint="all users, all sports" />
        <Stat label="Stuck pending" value={view.stuckTotal} alert={view.stuckTotal > 0} />
        <Stat label="Past the lookback" value={pastLookback} hint={`older than ${view.lookbackDays} days: never retried`} />
        <Stat label={`Fuzzy-graded, ${GRADING_FUZZY_WINDOW_DAYS} days`} value={view.fuzzyGraded} hint="graded on a non-exact team match" />
      </dl>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">Pending by sport</h2>
        {view.bySport.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending picks.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Sport</th>
                  <th className="py-2 pr-3 text-right font-medium">Pending</th>
                  <th className="py-2 pr-3 text-right font-medium">In lookback</th>
                  <th className="py-2 pr-3 text-right font-medium">Past lookback</th>
                  <th className="py-2 text-right font-medium">Stuck</th>
                </tr>
              </thead>
              <tbody>
                {view.bySport.map((s) => (
                  <tr key={s.sport} className={`border-b border-border-subtle ${s.stuck > 0 ? "bg-[#FDECEC] dark:bg-[#DC2626]/15" : ""}`}>
                    <td className="py-1.5 pr-3 text-foreground">
                      {s.sport}
                      {!s.autoGraded && <span className="text-xs text-muted-foreground"> · not auto-graded</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-foreground">{s.pending}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{s.inLookback}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{s.pastLookback}</td>
                    <td className="py-1.5 text-right tabular-nums text-foreground">{s.stuck}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">
          Stuck pending{view.stuckTotal > view.stuck.length ? ` (oldest ${view.stuck.length} of ${view.stuckTotal})` : ""}
        </h2>
        {view.stuck.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="space-y-2">
            {view.stuck.map((p) => (
              <li key={p.id} className="rounded-lg border border-border-subtle p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-foreground">
                    {p.sport} {p.betType}
                    {p.period !== "FULL_GAME" ? ` ${p.period}` : ""} - {p.betDetail ?? "(no bet text)"}
                  </span>
                  <span className="text-xs font-medium text-[#B91C1C] dark:text-[#F87171]">{stuckSince(p, view.now)}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {p.awayTeam} @ {p.homeTeam} · {p.gameTime.toISOString().slice(0, 16).replace("T", " ")} UTC · pick {shortId(p.id)}
                </div>
                <div className="mt-1 text-xs text-foreground">
                  {p.reason ? (
                    <>
                      Last grading failure: {p.reason}{" "}
                      <span className="text-muted-foreground">
                        ({p.attempts} attempt{p.attempts === 1 ? "" : "s"})
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No grading failure recorded yet.</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ReportDetails report={report} />
    </div>
  );
}

function Stat({ label, value, hint, alert = false }: { label: string; value: number; hint?: string; alert?: boolean }) {
  return (
    <div className="rounded-lg border border-border-subtle p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 text-lg font-semibold tabular-nums ${alert ? "text-[#B91C1C] dark:text-[#F87171]" : "text-foreground"}`}>{value.toLocaleString("en-US")}</dd>
      {hint && <dd className="mt-0.5 text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}
