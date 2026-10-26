import { requireAdminOpsPage } from "@/server/admin-gate";
import { ADMIN_BUG_REPORT_LIMIT, listBugReportsForAdmin } from "@/server/data/bug-reports";
import { BugReportControls } from "@/components/admin/bug-report-controls";

// User bug reports from Settings, admin-only (requireAdminOpsPage). One bounded
// read, no image bytes (a screenshot opens through a signed URL on click), no
// cache, no polling - reload to refresh. Resolving deletes the screenshot.
export default async function BugReportsPage() {
  await requireAdminOpsPage();
  const reports = await listBugReportsForAdmin();
  const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const open = reports.filter((r) => r.status === "OPEN").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Bug reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {open} open of the latest {Math.min(reports.length, ADMIN_BUG_REPORT_LIMIT)}. Open first, then newest. Resolving a report deletes its screenshot. Reload to refresh.
        </p>
      </div>

      {reports.length === 0 ? (
        <p className="text-sm text-muted-foreground">No bug reports yet.</p>
      ) : (
        <ul className="space-y-3">
          {reports.map((r) => (
            <li key={r.id} className="space-y-2 rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  <span className={r.status === "OPEN" ? "font-medium text-foreground" : ""}>{r.status}</span> · {r.user.email} · {fmt(r.createdAt)}
                </span>
                {r.pagePath && <span className="font-mono">{r.pagePath}</span>}
              </div>
              <p className="whitespace-pre-wrap break-words text-sm text-foreground">{r.description}</p>
              {r.userAgent && <p className="break-words text-xs text-muted-foreground">{r.userAgent}</p>}
              <BugReportControls id={r.id} hasScreenshot={Boolean(r.screenshotPath)} resolved={r.status === "RESOLVED"} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
