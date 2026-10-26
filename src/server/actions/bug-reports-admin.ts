"use server";

import { revalidatePath } from "next/cache";
import { requireAdminOpsAction } from "@/server/admin-gate";
import { getBugReportScreenshotPath, markBugReportResolved } from "@/server/data/bug-reports";
import { isScreenshotStorageConfigured, removeScreenshot, signScreenshotUrl } from "@/server/bug-reports/storage";

export type BugReportAdminResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// A 60-second signed URL, minted on click. Server actions are public POST
// endpoints, so the admin gate runs here too.
export async function getBugReportScreenshotUrlAction(id: string): Promise<BugReportAdminResult<{ url: string }>> {
  await requireAdminOpsAction();
  try {
    const path = await getBugReportScreenshotPath(String(id));
    if (!path) return { ok: false, error: "This report has no screenshot." };
    return { ok: true, url: await signScreenshotUrl(path) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not open the screenshot." };
  }
}

// Resolve = delete the screenshot object, null the path, mark RESOLVED. The
// object goes first: if that fails the report stays open and can be retried,
// rather than resolving a row whose file would then be unreachable forever.
export async function resolveBugReportAction(id: string): Promise<BugReportAdminResult> {
  await requireAdminOpsAction();
  try {
    const path = await getBugReportScreenshotPath(String(id));
    if (path) {
      if (!isScreenshotStorageConfigured()) return { ok: false, error: "Screenshot storage is not configured." };
      await removeScreenshot(path);
    }
    await markBugReportResolved(String(id));
    revalidatePath("/admin/bug-reports");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not resolve the report." };
  }
}
