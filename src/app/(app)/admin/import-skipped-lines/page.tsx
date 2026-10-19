import { redirect } from "next/navigation";
import { requireAdminOpsPage } from "@/server/admin-gate";

// The Skipped Lines report's old URL. It moved under the Imports tab
// (/admin/imports/skipped-lines); bookmarks keep working, date range included.
// Gated first, like every page under /admin, so a non-admin still gets a 404
// rather than learning the new path.
export default async function ImportSkippedLinesRedirect({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireAdminOpsPage();
  const query = new URLSearchParams();
  for (const key of ["from", "to"] as const) {
    const v = searchParams[key];
    if (typeof v === "string" && v) query.set(key, v);
  }
  const qs = query.toString();
  redirect(`/admin/imports/skipped-lines${qs ? `?${qs}` : ""}`);
}
