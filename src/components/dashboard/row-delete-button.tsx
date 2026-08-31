"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type ActionResult = { success: true } | { success: false; error: string };

// Compact inline "are you sure" delete control for a list row - a muted x
// that, on click, swaps to "Delete <thing>? [Yes] [No]" in place (no modal,
// no window.confirm). Mirrors the confirm-then-act shape of
// CapperEditPanel's delete mode, sized for a row instead of a panel.
//
// `onConfirm` is a bound server action (e.g. deletePickAction.bind(null, id))
// passed from the server component, so this file imports no actions itself.
export function RowDeleteButton({
  onConfirm,
  itemLabel,
}: {
  onConfirm: () => Promise<ActionResult>;
  itemLabel: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setConfirming(false);
    setError(null);
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await onConfirm();
      if (result.success) {
        setConfirming(false);
        // The action's revalidatePath re-renders the server tree; refresh
        // pulls it immediately so the row disappears without a navigation.
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
        aria-label={`Delete ${itemLabel}`}
        onClick={() => setConfirming(true)}
        className="rounded-full p-1 text-muted-foreground transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-400"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-xs">
      <span className={error ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}>
        {error ?? `Delete ${itemLabel}?`}
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
        onClick={reset}
        disabled={isPending}
        className="rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
      >
        No
      </button>
    </span>
  );
}
