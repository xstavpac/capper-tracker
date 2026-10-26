"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getBugReportScreenshotUrlAction, resolveBugReportAction } from "@/server/actions/bug-reports-admin";
import { ADMIN_BUTTON } from "@/components/admin/report-controls";

// Row actions on the Bug reports tab. "View screenshot" mints a 60 s signed URL
// on click, so the list itself never downloads an image.
export function BugReportControls({ id, hasScreenshot, resolved }: { id: string; hasScreenshot: boolean; resolved: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function view() {
    setError(null);
    startTransition(async () => {
      const result = await getBugReportScreenshotUrlAction(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      window.open(result.url, "_blank", "noopener,noreferrer");
    });
  }

  function resolve() {
    setError(null);
    startTransition(async () => {
      const result = await resolveBugReportAction(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasScreenshot && (
        <button type="button" onClick={view} disabled={pending} className={ADMIN_BUTTON}>
          View screenshot
        </button>
      )}
      {!resolved && (
        <button type="button" onClick={resolve} disabled={pending} className={ADMIN_BUTTON}>
          {hasScreenshot ? "Resolve and delete screenshot" : "Resolve"}
        </button>
      )}
      {error && <span className="text-xs text-[#DC2626] dark:text-[#F87171]">{error}</span>}
    </div>
  );
}
