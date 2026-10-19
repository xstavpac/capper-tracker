"use client";

import { useState } from "react";

export const ADMIN_BUTTON = "rounded-md border border-border bg-muted px-3 py-1.5 text-sm text-foreground hover:bg-muted/70 disabled:opacity-50";

// "Copy for Claude" on every ops console tab: copies the server-built
// plain-text report. The same text is on the page in ReportDetails, so a
// browser that blocks clipboard access still has it.
export function CopyReportButton({ report }: { report: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  }

  return (
    <button type="button" onClick={copy} className={ADMIN_BUTTON}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed - use the text below" : "Copy for Claude"}
    </button>
  );
}

export function ReportDetails({ report }: { report: string }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">Report text (what &quot;Copy for Claude&quot; copies)</summary>
      <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-muted p-3 font-mono text-xs text-foreground">{report}</pre>
    </details>
  );
}
