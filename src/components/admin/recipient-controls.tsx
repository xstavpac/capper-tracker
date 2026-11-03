"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addRecipientAction, pauseRecipientAction, removeRecipientAction, resumeRecipientAction } from "@/server/actions/pick-recipients-admin";
import { ADMIN_BUTTON } from "@/components/admin/report-controls";

const ERROR_CLASS = "text-xs text-[#DC2626] dark:text-[#F87171]";

// Pause / Resume / Remove for one recipient row. Remove asks first, in the row, not with a browser dialog.
export function RecipientRowControls({ id, status }: { id: string; status: "ACTIVE" | "PAUSED" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  function run(action: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "ACTIVE" ? (
        <button type="button" onClick={() => run(pauseRecipientAction)} disabled={pending} className={ADMIN_BUTTON}>
          Pause
        </button>
      ) : (
        <button type="button" onClick={() => run(resumeRecipientAction)} disabled={pending} className={ADMIN_BUTTON}>
          Resume
        </button>
      )}
      {confirming ? (
        <>
          <span className="text-xs text-muted-foreground">Remove this recipient? Picks already delivered stay.</span>
          <button type="button" onClick={() => run(removeRecipientAction)} disabled={pending} className={ADMIN_BUTTON}>
            Yes, remove
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={pending} className={ADMIN_BUTTON}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} disabled={pending} className={ADMIN_BUTTON}>
          Remove
        </button>
      )}
      {error && <span className={ERROR_CLASS}>{error}</span>}
    </div>
  );
}

export type SourceOption = { id: string; label: string };

// Add by user id or email. The server validates the user exists; the new row is ACTIVE.
export function AddRecipientForm({ sources }: { sources: SourceOption[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await addRecipientAction(sourceId, query);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setQuery("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
      <label className="space-y-1 text-xs text-muted-foreground">
        <span className="block">Recipient (user id or email)</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="user id or email"
          className="w-72 max-w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
        />
      </label>
      {sources.length > 1 && (
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Receives picks imported by</span>
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground">
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" disabled={pending || query.trim() === ""} className={ADMIN_BUTTON}>
        Add recipient
      </button>
      {error && <span className={ERROR_CLASS}>{error}</span>}
    </form>
  );
}
