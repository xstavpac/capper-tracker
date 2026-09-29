"use client";

// One-time, dismissible summary of legs removed from the Parlay slip because
// their game started, they were graded/voided, or the pick was deleted (see
// parlay-pool-context.tsx). Mounted once in (app)/layout.tsx above the page.
import { useParlayPool } from "@/components/parlay/parlay-pool-context";

export function ParlaySlipNotice() {
  const { notice, dismissNotice } = useParlayPool();
  if (!notice || notice.length === 0) return null;

  return (
    <div role="status" className="mb-4 rounded-xl border border-border bg-muted p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium text-foreground">
          {notice.length === 1
            ? "1 leg was removed from your Parlay slip"
            : notice.length + " legs were removed from your Parlay slip"}
        </p>
        <button
          onClick={dismissNotice}
          aria-label="Dismiss notice"
          className="shrink-0 rounded-lg px-2 py-0.5 text-muted-foreground transition hover:bg-card hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
      <ul className="mt-2 space-y-1 text-muted-foreground">
        {notice.map((l) => (
          <li key={l.pickId} className="flex justify-between gap-3">
            <span className="min-w-0 truncate">{l.label}</span>
            <span className="shrink-0 font-medium text-foreground">{l.result}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
