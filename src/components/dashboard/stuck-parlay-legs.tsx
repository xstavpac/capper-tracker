"use client";

import { useState } from "react";
import { updateLegStatusAction } from "@/server/actions/parlays";
import type { StuckParlayLegRow } from "@/server/data/picks";
import type { PickStatus } from "@prisma/client";
import { formatPickLabel } from "@/lib/bet-line";

// Same age formatting as PendingTriage (pending-triage.tsx) - a stuck leg is
// always past the 6h grace, but keep the negative-safe floor for parity.
function formatAge(ageHours: number) {
  if (ageHours < 0) return "Starts in " + Math.floor(-ageHours) + "h";
  return "Pending " + Math.floor(ageHours) + "h";
}

// Sibling of PendingTriage, same card / divide-y row / grade-button pattern,
// pointed at parlay legs instead of standalone picks. No bulk-select here -
// a leg is graded individually (updateLegStatusAction also recomputes its
// parent parlay), and stuck legs are rare enough not to need batch actions.
export function StuckParlayLegs({ legs }: { legs: StuckParlayLegRow[] }) {
  const [rows, setRows] = useState(legs);
  const [busy, setBusy] = useState(false);

  async function gradeOne(legId: string, status: PickStatus) {
    setBusy(true);
    const result = await updateLegStatusAction(legId, status);
    setBusy(false);
    if (result.success) setRows((prev) => prev.filter((r) => r.legId !== legId));
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-card bg-card p-10 text-center shadow-soft">
        <p className="text-sm text-muted-foreground">No stuck parlay legs.</p>
      </div>
    );
  }

  return (
    <div className="rounded-card bg-card p-5 shadow-soft">
      <div className="divide-y divide-border-subtle">
        {rows.map((leg) => (
          <div key={leg.legId} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                {leg.capperName} &middot; {formatPickLabel(leg.betDetail, leg.betType, leg.line) ?? leg.betType}{" "}
                &middot; {leg.odds > 0 ? "+" : ""}
                {leg.odds}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {leg.awayTeam} @ {leg.homeTeam} &middot; parlay leg {leg.legIndex + 1} of {leg.legCount} &middot;{" "}
                {leg.parlayUnits}u
              </div>
              <div className="mt-1">
                {leg.reason ? (
                  <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600 dark:bg-rose-500/15 dark:text-rose-400">
                    Stuck &middot; {leg.reason}
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                    {formatAge(leg.ageHours)} &middot; not graded yet
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                disabled={busy}
                onClick={() => gradeOne(leg.legId, "WIN")}
                className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                Win
              </button>
              <button
                disabled={busy}
                onClick={() => gradeOne(leg.legId, "LOSS")}
                className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                Loss
              </button>
              <button
                disabled={busy}
                onClick={() => gradeOne(leg.legId, "PUSH")}
                className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                Push
              </button>
              <button
                disabled={busy}
                onClick={() => gradeOne(leg.legId, "CANCELLED")}
                className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10 disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
