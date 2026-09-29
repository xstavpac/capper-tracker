import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { isFeatureEnabledForUser, IMPORT_SKIPPED_LINES_FLAG_KEY } from "@/server/data/feature-flags";
import { getSkippedLineReport, resolveReportRange } from "@/server/data/import-skipped-lines-report";

// Gated server-side on the import_skipped_lines feature flag, same pattern as
// /zone-model: the sidebar link is only a convenience, a direct request
// without the flag 404s here. Server-rendered and on-demand - the date
// filter is a plain GET form, no client state or polling.
export default async function ImportSkippedLinesPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const user = await requireUser();
  if (!(await isFeatureEnabledForUser(IMPORT_SKIPPED_LINES_FLAG_KEY, user.id))) notFound();

  const { from, to, fromInput, toInput } = resolveReportRange(searchParams.from, searchParams.to);
  const report = await getSkippedLineReport(from, to);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Import skipped lines</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every catalog line the importer failed to turn into a pick, across all users. {report.total} in range.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-muted-foreground">
          From
          <input type="date" name="from" defaultValue={fromInput} className="rounded-md border border-border bg-background px-2 py-1 text-foreground" />
        </label>
        <label className="flex flex-col gap-1 text-muted-foreground">
          To (inclusive)
          <input type="date" name="to" defaultValue={toInput} className="rounded-md border border-border bg-background px-2 py-1 text-foreground" />
        </label>
        <button type="submit" className="rounded-md border border-border bg-muted px-3 py-1 text-foreground hover:bg-muted/70">
          Apply
        </button>
      </form>

      <section>
        <h2 className="mb-2 text-lg font-medium text-foreground">By stage</h2>
        {report.byStage.length === 0 ? (
          <p className="text-sm text-muted-foreground">No skipped lines in this range.</p>
        ) : (
          <table className="w-full max-w-md text-sm">
            <tbody>
              {report.byStage.map((s) => (
                <tr key={s.stage} className="border-b border-border-subtle">
                  <td className="py-1.5 font-mono text-foreground">{s.stage}</td>
                  <td className="py-1.5 text-right tabular-nums text-foreground">{s.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium text-foreground">By market</h2>
        <div className="space-y-4">
          {report.byMarketHint.map((b) => (
            <div key={b.marketHint ?? "(none)"} className="rounded-lg border border-border-subtle p-3">
              <div className="flex items-baseline justify-between">
                <h3 className="font-medium text-foreground">{b.marketHint ?? "(no market keyword)"}</h3>
                <span className="tabular-nums text-foreground">{b.count}</span>
              </div>
              <ul className="mt-2 space-y-0.5 text-sm text-muted-foreground">
                {b.topLines.map((l) => (
                  <li key={l.rawText} className="flex justify-between gap-4">
                    <span className="break-words">{l.rawText}</span>
                    <span className="tabular-nums">&times;{l.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
