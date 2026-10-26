"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { requireUser } from "@/server/auth";
import { recentBugReportActivity, insertBugReport } from "@/server/data/bug-reports";
import { isScreenshotStorageConfigured, removeScreenshot, uploadScreenshot } from "@/server/bug-reports/storage";
import { submitBugReport, type BugReportResult } from "@/server/bug-reports/submit";

// Settings > Report a bug. userId comes from the session, never the form. The
// form is: description (text), pagePath (text), screenshot (optional File,
// already shrunk by the browser; the limits are re-checked in submitBugReport).
export async function submitBugReportAction(formData: FormData): Promise<BugReportResult> {
  const user = await requireUser();

  const file = formData.get("screenshot");
  const screenshot = file instanceof File && file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : null;

  try {
    return await submitBugReport(
      {
        now: () => new Date(),
        newId: () => randomUUID(),
        recentActivity: recentBugReportActivity,
        storageConfigured: isScreenshotStorageConfigured,
        upload: uploadScreenshot,
        remove: removeScreenshot,
        insert: insertBugReport,
      },
      {
        userId: user.id,
        description: formData.get("description"),
        pagePath: formData.get("pagePath"),
        userAgent: headers().get("user-agent"),
        screenshot,
      }
    );
  } catch {
    return { ok: false, error: "Could not save your report. Please try again." };
  }
}
