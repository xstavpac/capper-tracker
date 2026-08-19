"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { renameCapperAction, deleteCapperAction, mergeCappersAction } from "@/server/actions/cappers";

type CapperSummary = { id: string; name: string; pickCount: number };
type Mode = "closed" | "menu" | "rename" | "merge" | "merge-confirm" | "delete";

// Three explicit, user-chosen actions rather than inferring merge-vs-rename
// from whether the typed name happens to match an existing capper - that
// string-matching approach is fragile in both directions (a real duplicate
// under a slightly different spelling wouldn't match; a coincidental exact
// match on an unrelated capper would wrongly trigger a merge). The action
// the user picks here is the only signal this ever needs.
export function CapperEditPanel({
  capperId,
  currentName,
  otherCappers,
  associatedPickCount,
}: {
  capperId: string;
  currentName: string;
  otherCappers: CapperSummary[];
  associatedPickCount: number;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("closed");
  const [name, setName] = useState(currentName);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function close() {
    setMode("closed");
    setError(null);
    setName(currentName);
    setMergeTargetId("");
  }

  function submitRename() {
    setError(null);
    startTransition(async () => {
      const result = await renameCapperAction(capperId, name);
      if (result.success) {
        close();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  function confirmMerge() {
    if (!mergeTargetId) return;
    setError(null);
    startTransition(async () => {
      // This capper is always the duplicate side - the profile page you're
      // editing is the one being folded away, the picked target is kept.
      const result = await mergeCappersAction(mergeTargetId, capperId);
      if (result.success) {
        // This capper no longer exists once the merge completes - land on
        // the surviving capper's page instead of a now-dead route.
        router.push("/cappers/" + mergeTargetId);
      } else {
        setError(result.error);
      }
    });
  }

  function confirmDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteCapperAction(capperId);
      if (result.success) {
        router.push("/cappers");
      } else {
        setError(result.error);
      }
    });
  }

  const mergeTarget = otherCappers.find((c) => c.id === mergeTargetId);

  if (mode === "closed") {
    return (
      <button
        type="button"
        onClick={() => setMode("menu")}
        className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted"
      >
        Edit
      </button>
    );
  }

  return (
    <div className="w-full rounded-card border border-border bg-card p-4 shadow-soft sm:w-80">
      {error && (
        <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {mode === "menu" && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setMode("rename")}
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-foreground hover:bg-muted"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => setMode("merge")}
            disabled={otherCappers.length === 0}
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-foreground hover:bg-muted disabled:opacity-50"
          >
            Merge into existing capper
          </button>
          <button
            type="button"
            onClick={() => setMode("delete")}
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={close}
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      )}

      {mode === "rename" && (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Capper name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground"
            autoFocus
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={submitRename}
              disabled={isPending || !name.trim()}
              className="rounded-full bg-brand-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {isPending ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={close}
              disabled={isPending}
              className="rounded-full px-4 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "merge" && (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Merge &quot;{currentName}&quot; into...
          </label>
          <select
            value={mergeTargetId}
            onChange={(e) => setMergeTargetId(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            autoFocus
          >
            <option value="">Select a capper...</option>
            {otherCappers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.pickCount})
              </option>
            ))}
          </select>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setMode("merge-confirm")}
              disabled={!mergeTargetId}
              className="rounded-full bg-brand-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              Review merge
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-full px-4 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "merge-confirm" && mergeTarget && (
        <div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-500/10">
            <div className="font-medium text-amber-900 dark:text-amber-200">Confirm merge</div>
            <div className="mt-1.5 text-amber-800 dark:text-amber-300">
              Keep <span className="font-medium">&quot;{mergeTarget.name}&quot;</span> ({mergeTarget.pickCount} pick
              {mergeTarget.pickCount === 1 ? "" : "s"})
            </div>
            <div className="text-amber-800 dark:text-amber-300">
              Remove <span className="font-medium">&quot;{currentName}&quot;</span> and move its{" "}
              {associatedPickCount} pick{associatedPickCount === 1 ? "" : "s"} onto {mergeTarget.name}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirmMerge}
              disabled={isPending}
              className="rounded-full bg-brand-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {isPending ? "Merging..." : "Confirm merge"}
            </button>
            <button
              type="button"
              onClick={() => setMode("merge")}
              disabled={isPending}
              className="rounded-full px-4 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {mode === "delete" && (
        <div>
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-500/10">
            <div className="font-medium text-red-900 dark:text-red-300">Delete &quot;{currentName}&quot;?</div>
            <div className="mt-1.5 text-red-800 dark:text-red-400">
              This will delete {associatedPickCount} associated pick{associatedPickCount === 1 ? "" : "s"}. This
              can&apos;t be undone.
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={confirmDelete}
              disabled={isPending}
              className="rounded-full bg-red-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {isPending ? "Deleting..." : "Confirm delete"}
            </button>
            <button
              type="button"
              onClick={close}
              disabled={isPending}
              className="rounded-full px-4 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
