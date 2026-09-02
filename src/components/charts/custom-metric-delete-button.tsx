"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteCustomMetricAction } from "@/server/actions/custom-metrics";

// Compact inline "are you sure" delete control for one custom metric in the
// Variables list. Same confirm-then-act shape as RowDeleteButton
// (components/dashboard/row-delete-button.tsx) - a muted x that swaps in place
// to `Delete "<name>"? [Yes] [No]`, no modal, no window.confirm. Unlike
// RowDeleteButton it calls the server action itself (this list is a client
// component, not server-rendered) and takes an onDeleted callback so the
// workspace can prune any plotted series for the removed metric.
export function CustomMetricDeleteButton({
  metricId,
  label,
  onDeleted,
}: {
  metricId: string;
  label: string;
  onDeleted?: (metricId: string) => void;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await deleteCustomMetricAction(metricId);
      if (result.success) {
        setConfirming(false);
        onDeleted?.(metricId);
        // revalidatePath in the action re-runs charts/page.tsx; refresh pulls
        // it so the row disappears from the library without a navigation.
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  if (!confirming) {
    return (
      <button
        type="button"
        aria-label={`Delete custom metric ${label}`}
        onClick={() => setConfirming(true)}
        className="shrink-0 rounded-full p-1 text-muted-foreground transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-400"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap pl-2 text-xs">
      <span className={error ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}>
        {error ?? `Delete "${label}"?`}
      </span>
      <button
        type="button"
        onClick={confirm}
        disabled={isPending}
        className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
      >
        {isPending ? "Deleting..." : "Yes"}
      </button>
      <button
        type="button"
        onClick={() => {
          setConfirming(false);
          setError(null);
        }}
        disabled={isPending}
        className="rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
      >
        No
      </button>
    </span>
  );
}
