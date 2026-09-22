"use client";

// The "Parlay slip" header control - off by default, toggles add mode on
// every pick card that supports it (see pick-card.tsx). Mounted on both the
// Live page and the Parlay tab, sharing one ParlayPoolProvider, so checking
// picks on either page contributes to the same running selection.
import { useState } from "react";
import { useParlayPool } from "@/components/parlay/parlay-pool-context";

export function ParlaySlipButton() {
  const { pool, addMode, checkedPicks, enterAddMode, confirmAdd, discardAdd } = useParlayPool();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const checkedCount = checkedPicks.size;
  const label = "Parlay slip" + (addMode ? (checkedCount > 0 ? " · " + checkedCount : "") : (pool.length > 0 ? " · " + pool.length : ""));

  function handleToggle() {
    if (!addMode) {
      enterAddMode();
      return;
    }
    if (checkedCount === 0) {
      discardAdd();
      return;
    }
    // Leaving add mode with unconfirmed checks discards them - warn first
    // rather than silently wiping the selection.
    setConfirmingDiscard(true);
  }

  if (confirmingDiscard) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-soft">
        <span className="text-muted-foreground">
          Discard {checkedCount} selected pick{checkedCount === 1 ? "" : "s"}?
        </span>
        <button
          onClick={() => setConfirmingDiscard(false)}
          className="rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            setConfirmingDiscard(false);
            discardAdd();
          }}
          className="rounded-full bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700"
        >
          Discard
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleToggle}
        className={
          "rounded-full px-3.5 py-1.5 text-sm font-medium shadow-soft transition " +
          (addMode
            ? "bg-foreground text-background"
            : "bg-card text-muted-foreground hover:bg-muted")
        }
      >
        {label}
      </button>
      {addMode && checkedCount > 0 && (
        <button
          onClick={confirmAdd}
          className="rounded-full bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-soft hover:bg-brand-700"
        >
          Confirm
        </button>
      )}
    </div>
  );
}
