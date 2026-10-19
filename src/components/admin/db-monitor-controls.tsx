"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resetDbStatsAction } from "@/server/actions/db-monitor";

const BUTTON = "rounded-md border border-border bg-muted px-3 py-1.5 text-sm text-foreground hover:bg-muted/70 disabled:opacity-50";

// Copies the server-built plain-text report. The same text is on the page in
// a <details> block, so a browser that blocks clipboard access still has it.
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
    <button type="button" onClick={copy} className={BUTTON}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed - use the text below" : "Copy for Claude"}
    </button>
  );
}

// "Reset stats" behind an in-page confirm (not window.confirm), then a
// refresh so the page re-reads the now-empty stats.
export function ResetStatsButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending]);

  function confirmReset() {
    setError(null);
    startTransition(async () => {
      const result = await resetDbStatsAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={BUTTON}>
        Reset stats
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="reset-stats-title" className="w-full max-w-md space-y-3 rounded-lg border border-border bg-card p-5 shadow-soft">
            <h2 id="reset-stats-title" className="text-base font-semibold text-foreground">
              Reset pg_stat_statements?
            </h2>
            <p className="text-sm text-muted-foreground">
              Clears every statement&apos;s counters for the whole database server, for every role - including what
              Supabase&apos;s own Query Performance view shows. It can&apos;t be undone.
            </p>
            {error && <p className="text-sm text-[#DC2626] dark:text-[#F87171]">Reset failed: {error}</p>}
            <div className="flex justify-end gap-2">
              <button ref={cancelRef} type="button" onClick={() => setOpen(false)} disabled={pending} className={BUTTON}>
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmReset}
                disabled={pending}
                className="rounded-md bg-[#DC2626] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#B91C1C] disabled:opacity-50"
              >
                {pending ? "Resetting..." : "Reset stats"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
