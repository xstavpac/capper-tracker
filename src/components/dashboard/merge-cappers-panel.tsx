"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { mergeCappersAction, dismissDuplicatePairAction } from "@/server/actions/cappers";

type CapperSummary = { id: string; name: string; pickCount: number };
type SuspectedDuplicatePair = { capperA: CapperSummary; capperB: CapperSummary; distance: number };

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

// A pending merge - `primary` is kept (picks moved onto it), `duplicate` is
// removed. Which side is which is a user choice (via the confirm step's
// "Swap" control), not implied by suggestion order - findSuspectedDuplicateCappers
// has no basis for guessing which spelling the user actually wants to keep.
type PendingMerge = { primary: CapperSummary; duplicate: CapperSummary };

export function MergeCappersPanel({
  cappers,
  suspected,
}: {
  cappers: CapperSummary[];
  suspected: SuspectedDuplicatePair[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingMerge | null>(null);
  const [manualPrimaryId, setManualPrimaryId] = useState("");
  const [manualDuplicateId, setManualDuplicateId] = useState("");
  const [message, setMessage] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  const [isMerging, startTransition] = useTransition();
  const [dismissingKey, setDismissingKey] = useState<string | null>(null);

  // For a suggested pair (order is arbitrary, alphabetical): default to
  // keeping whichever name has more picks (the more-established record) -
  // just a starting suggestion, the confirm step lets the user swap.
  function reviewSuggestedPair(a: CapperSummary, b: CapperSummary) {
    setMessage(null);
    setPending(a.pickCount >= b.pickCount ? { primary: a, duplicate: b } : { primary: b, duplicate: a });
  }

  // For the manual selector, the user already explicitly chose which to
  // keep - respect that instead of re-deriving it from pick counts.
  function reviewManualPair(primary: CapperSummary, duplicate: CapperSummary) {
    setMessage(null);
    setPending({ primary, duplicate });
  }

  function swapPending() {
    if (!pending) return;
    setPending({ primary: pending.duplicate, duplicate: pending.primary });
  }

  function confirmMerge() {
    if (!pending) return;
    const { primary, duplicate } = pending;
    startTransition(async () => {
      const result = await mergeCappersAction(primary.id, duplicate.id);
      if (result.success) {
        setMessage({
          text: `Merged "${result.duplicateName}" into "${result.primaryName}" - ${result.mergedPickCount} pick${result.mergedPickCount === 1 ? "" : "s"} moved.`,
          tone: "success",
        });
        setPending(null);
        setManualPrimaryId("");
        setManualDuplicateId("");
        router.refresh();
      } else {
        setMessage({ text: result.error, tone: "error" });
      }
    });
  }

  // Persists the dismissal server-side (dismissDuplicatePairAction) keyed by
  // capper id, order-independent - then re-fetches so the pair is excluded
  // by findSuspectedDuplicateCappers itself on the next render, rather than
  // relying on client-only state that used to reset on every reload.
  async function dismissPair(a: CapperSummary, b: CapperSummary) {
    const key = pairKey(a.id, b.id);
    setMessage(null);
    setDismissingKey(key);
    const result = await dismissDuplicatePairAction(a.id, b.id);
    if (result.success) {
      router.refresh();
    } else {
      setMessage({ text: result.error, tone: "error" });
    }
    setDismissingKey(null);
  }

  const manualReady = manualPrimaryId && manualDuplicateId && manualPrimaryId !== manualDuplicateId;
  const manualPrimary = cappers.find((c) => c.id === manualPrimaryId);
  const manualDuplicate = cappers.find((c) => c.id === manualDuplicateId);

  return (
    <div className="rounded-card bg-card p-5 shadow-soft">
      <h3 className="text-sm font-medium text-foreground">Merge duplicate cappers</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Combines two capper records into one - every pick moves to the capper you keep, and the
        other record is removed. This can&apos;t be undone.
      </p>

      {message && (
        <div
          className={
            "mt-3 rounded-lg px-3 py-2 text-sm " +
            (message.tone === "success"
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
              : "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400")
          }
        >
          {message.text}
        </div>
      )}

      {pending && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-500/10">
          <div className="font-medium text-amber-900 dark:text-amber-200">Confirm merge</div>
          <div className="mt-1.5 text-amber-800 dark:text-amber-300">
            Keep <span className="font-medium">"{pending.primary.name}"</span> ({pending.primary.pickCount} pick
            {pending.primary.pickCount === 1 ? "" : "s"})
          </div>
          <div className="text-amber-800 dark:text-amber-300">
            Remove <span className="font-medium">"{pending.duplicate.name}"</span> and move its{" "}
            {pending.duplicate.pickCount} pick{pending.duplicate.pickCount === 1 ? "" : "s"} onto{" "}
            {pending.primary.name}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={confirmMerge}
              disabled={isMerging}
              className="rounded-full bg-brand-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {isMerging ? "Merging..." : "Confirm merge"}
            </button>
            <button
              onClick={swapPending}
              disabled={isMerging}
              className="rounded-full border border-amber-300 bg-card px-4 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
            >
              Swap - keep {pending.duplicate.name} instead
            </button>
            <button
              onClick={() => setPending(null)}
              disabled={isMerging}
              className="rounded-full px-4 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Suspected duplicates
        </div>
        {suspected.length === 0 ? (
          <p className="text-sm text-muted-foreground">No likely duplicates found.</p>
        ) : (
          <div className="space-y-1.5">
            {suspected.map((p) => {
              const key = pairKey(p.capperA.id, p.capperB.id);
              const isDismissing = dismissingKey === key;
              return (
                <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
                  <div>
                    <span className="font-medium text-foreground">{p.capperA.name}</span>
                    <span className="mx-1.5 text-muted-foreground">~</span>
                    <span className="font-medium text-foreground">{p.capperB.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {p.distance === 0 ? "exact match" : `${p.distance}-character difference`}
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => reviewSuggestedPair(p.capperA, p.capperB)}
                      disabled={isDismissing}
                      className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted disabled:opacity-50"
                    >
                      Review merge
                    </button>
                    <button
                      onClick={() => dismissPair(p.capperA, p.capperB)}
                      disabled={isDismissing}
                      className="rounded-full px-3 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted disabled:opacity-50"
                    >
                      {isDismissing ? "Saving..." : "Not a duplicate"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Merge any two cappers</div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={manualPrimaryId}
            onChange={(e) => setManualPrimaryId(e.target.value)}
            className="rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">Keep this capper...</option>
            {cappers.map((c) => (
              <option key={c.id} value={c.id} disabled={c.id === manualDuplicateId}>
                {c.name} ({c.pickCount})
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">merge with</span>
          <select
            value={manualDuplicateId}
            onChange={(e) => setManualDuplicateId(e.target.value)}
            className="rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">This capper...</option>
            {cappers.map((c) => (
              <option key={c.id} value={c.id} disabled={c.id === manualPrimaryId}>
                {c.name} ({c.pickCount})
              </option>
            ))}
          </select>
          <button
            onClick={() => manualPrimary && manualDuplicate && reviewManualPair(manualPrimary, manualDuplicate)}
            disabled={!manualReady}
            className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted disabled:opacity-50"
          >
            Review merge
          </button>
        </div>
      </div>
    </div>
  );
}
