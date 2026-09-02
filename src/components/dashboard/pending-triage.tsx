"use client";

import { useState } from "react";
import { updatePickStatusAction } from "@/server/actions/picks";
import type { PendingPickRow } from "@/server/data/picks";
import type { PickStatus } from "@prisma/client";
import { formatPickLabel } from "@/lib/bet-line";

// Negative ageHours means the game hasn't started yet (gameTime is still in
// the future) - clamping that to "Pending 0h" read as stuck/frozen rather
// than upcoming. Floors the same way in both directions: an elapsed pick
// under an hour old still shows "Pending 0h" (unchanged), and a game under
// an hour from starting shows "Starts in 0h" rather than rounding up to 1.
function formatAge(ageHours: number) {
  if (ageHours < 0) return "Starts in " + Math.floor(-ageHours) + "h";
  return "Pending " + Math.floor(ageHours) + "h";
}

const STALE_HOURS = 24;

const ACTION_BUTTON_CLASS =
  "rounded-full px-2.5 py-1 text-xs font-medium disabled:opacity-50";

export function PendingTriage({ picks }: { picks: PendingPickRow[] }) {
  const [rows, setRows] = useState(picks);
  const [checked, setChecked] = useState(() => new Set(picks.map((p) => p.id)));
  const [busy, setBusy] = useState(false);

  const allChecked = rows.length > 0 && checked.size === rows.length;
  const checkedIds = rows.filter((r) => checked.has(r.id)).map((r) => r.id);

  function toggleAll() {
    setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.id)));
  }

  function toggleOne(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setChecked((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function gradeOne(id: string, status: PickStatus) {
    setBusy(true);
    const result = await updatePickStatusAction(id, status);
    setBusy(false);
    if (result.success) removeRow(id);
  }

  async function gradeChecked(status: PickStatus) {
    setBusy(true);
    const ids = checkedIds;
    const results = await Promise.all(ids.map((id) => updatePickStatusAction(id, status)));
    setBusy(false);
    ids.forEach((id, i) => {
      if (results[i].success) removeRow(id);
    });
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-card bg-card p-10 text-center shadow-soft">
        <p className="text-sm text-muted-foreground">No pending picks.</p>
      </div>
    );
  }

  return (
    <div className="rounded-card bg-card p-5 shadow-soft">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={toggleAll}
            className="h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-400"
          />
          {checked.size} selected
        </label>
        <div className="flex gap-2">
          <button
            disabled={busy || checked.size === 0}
            onClick={() => gradeChecked("WIN")}
            className={ACTION_BUTTON_CLASS + " bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:hover:bg-emerald-500/25"}
          >
            Grade all win
          </button>
          <button
            disabled={busy || checked.size === 0}
            onClick={() => gradeChecked("LOSS")}
            className={ACTION_BUTTON_CLASS + " bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-500/15 dark:text-red-300 dark:hover:bg-red-500/25"}
          >
            Grade all loss
          </button>
          <button
            disabled={busy || checked.size === 0}
            onClick={() => gradeChecked("CANCELLED")}
            className={ACTION_BUTTON_CLASS + " border border-border text-muted-foreground hover:bg-muted"}
          >
            Clear selected
          </button>
        </div>
      </div>

      <div className="divide-y divide-border-subtle">
        {rows.map((p) => {
          const stale = p.ageHours >= STALE_HOURS;
          return (
            <div key={p.id} className="flex items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <input
                  type="checkbox"
                  checked={checked.has(p.id)}
                  onChange={() => toggleOne(p.id)}
                  className="mt-1 h-4 w-4 shrink-0 rounded border-border text-brand-600 focus:ring-brand-400"
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {p.capperName} &middot; {formatPickLabel(p.betDetail, p.betType, p.line) ?? p.betType} &middot;{" "}
                    {p.odds > 0 ? "+" : ""}
                    {p.odds} &middot; {p.units}u
                  </div>
                  <div className="mt-1">
                    {p.unmatchedReason ? (
                      <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600 dark:bg-rose-500/15 dark:text-rose-400">
                        Unmatched &middot; {p.unmatchedReason}
                      </span>
                    ) : stale ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                        {formatAge(p.ageHours)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{formatAge(p.ageHours)}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  disabled={busy}
                  onClick={() => gradeOne(p.id, "WIN")}
                  className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                  Win
                </button>
                <button
                  disabled={busy}
                  onClick={() => gradeOne(p.id, "LOSS")}
                  className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                  Loss
                </button>
                <button
                  disabled={busy}
                  onClick={() => gradeOne(p.id, "PUSH")}
                  className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                  Push
                </button>
                <button
                  disabled={busy}
                  onClick={() => gradeOne(p.id, "CANCELLED")}
                  className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10 disabled:opacity-50"
                >
                  Clear
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
