import Link from "next/link";
import { requireAdminOpsPage } from "@/server/admin-gate";
import { loadImportsView } from "@/server/data/import-runs";
import { alertCounts, importsReport, isAlertStage } from "@/lib/import-health";
import { IMPORT_ALERT_STAGES, IMPORT_LISTED_STAGES } from "@/lib/admin-thresholds";
import { formatAdminReport, shortId } from "@/lib/admin-report";
import { CopyReportButton, ReportDetails } from "@/components/admin/report-controls";

// Import health, admin-only (requireAdminOpsPage), over the last
// IMPORT_WINDOW_HOURS: skipped lines by stage, picks inserted with no matched
// game, the unmatched / unreadable lines, and how ambiguous team names were
// settled. One statement per load (loadImportsView), read fresh; no cache, no
// polling. Reload to refresh. The full date-range report is Skipped Lines.
export default async function ImportsPage() {
  await requireAdminOpsPage();
  const view = await loadImportsView();
  const report = formatAdminReport(importsReport(view));
  const counts = alertCounts(view);
  const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Imports</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Last {view.windowHours}h, all users. Red: {IMPORT_ALERT_STAGES.join(", ")} lines, or a pick inserted with no matched game. Listed only: {IMPORT_LISTED_STAGES.join(", ")}. Reload to refresh.{" "}
            <Link href="/admin/imports/skipped-lines" className="text-foreground underline underline-offset-2">
              Skipped Lines report
            </Link>
          </p>
        </div>
        <CopyReportButton report={report} />
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <Stat label="Imports" value={view.runs.runs} hint={`${view.runs.items.toLocaleString("en-US")} lines submitted`} />
        <Stat label="Picks inserted" value={view.runs.inserted} hint={`${view.runs.skipped.toLocaleString("en-US")} skipped`} />
        <Stat label="No matched game" value={counts.fallback} alert={counts.fallback > 0} hint="inserted, game time = import time" />
        <Stat label="Unmatched / unreadable lines" value={counts.failed} alert={counts.failed > 0} />
      </dl>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">Skipped lines by stage</h2>
        {view.byStage.length === 0 ? (
          <p className="text-sm text-muted-foreground">No skipped lines.</p>
        ) : (
          <table className="w-full max-w-md text-sm">
            <tbody>
              {view.byStage.map((s) => (
                <tr key={s.stage} className={`border-b border-border-subtle ${isAlertStage(s.stage) ? "bg-[#FDECEC] dark:bg-[#DC2626]/15" : ""}`}>
                  <td className="py-1.5 pl-1 font-mono text-foreground">{s.stage}</td>
                  <td className="py-1.5 pr-1 text-right tabular-nums text-foreground">{s.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">Picks inserted with no matched game</h2>
        <p className="text-sm text-muted-foreground">Sports with no score source: the bet text became the home team, &quot;-&quot; the opponent, the import time the game time. Never auto-graded.</p>
        {view.fallbackPicks.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {view.fallbackPicks.map((f) => (
              <li key={f.pickId} className="flex flex-wrap justify-between gap-2 border-b border-border-subtle py-1.5">
                <span className="break-words text-foreground">
                  {f.sport} - {f.betDetail}
                </span>
                <span className="text-xs text-muted-foreground">pick {shortId(f.pickId)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">Unmatched / unreadable lines</h2>
        {view.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="space-y-2">
            {view.lines.map((l) => (
              <li key={l.id} className="rounded-lg border border-border-subtle p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="break-words font-mono text-foreground">{l.rawText}</span>
                  <span className={`text-xs font-medium ${isAlertStage(l.stage) ? "text-[#B91C1C] dark:text-[#F87171]" : "text-muted-foreground"}`}>{l.stage}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  capper &quot;{l.capperName}&quot;{l.guessedSport ? ` · ${l.guessedSport}` : ""} · {fmt(l.createdAt)}
                  {l.reason ? ` · ${l.reason}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">Ambiguous team names</h2>
        <p className="text-sm text-muted-foreground">
          {view.runs.ambiguousAuto} pick{view.runs.ambiguousAuto === 1 ? "" : "s"} settled automatically, {view.runs.ambiguousAsked} by asking.
        </p>
        {view.ambiguity.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Sport</th>
                  <th className="py-2 pr-3 font-medium">Settled by</th>
                  <th className="py-2 text-right font-medium">Picks</th>
                </tr>
              </thead>
              <tbody>
                {view.ambiguity.map((a) => (
                  <tr key={`${a.key}|${a.sport}|${a.method}`} className="border-b border-border-subtle">
                    <td className="py-1.5 pr-3 text-foreground">{a.key}</td>
                    <td className="py-1.5 pr-3 text-foreground">{a.sport}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{a.method === "user" ? "asked the user" : a.method}</td>
                    <td className="py-1.5 text-right tabular-nums text-foreground">{a.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
