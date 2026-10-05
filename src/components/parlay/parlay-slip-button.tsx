"use client";

// The "Parlay slip" header control - off by default, toggles add mode on
// every pick card that supports it (see pick-card.tsx). Mounted on both the
// Live page and the Parlay tab, sharing one ParlayPoolProvider, so checking
// picks on either page contributes to the same running selection.
import { useState } from "react";
import { useParlayPool } from "@/components/parlay/parlay-pool-context";
import { ClipboardIcon } from "@/components/dashboard/cappers-icons";

// `dark` is the look for the navy page banner (/live): pills, 34px, or 44px where the banner is 640px wide or more.
// The default is the light-surface look (/parlay).
const BANNER_PILL = "flex h-[34px] items-center rounded-full border text-[12.5px] transition [@container_(min-width:640px)]:h-11 [@container_(min-width:640px)]:text-sm ";
const BANNER_BUTTON = BANNER_PILL + "flex-none px-3.5 [@container_(min-width:640px)]:px-[18px] ";
const BANNER_IDLE = "border-[rgba(96,140,255,0.28)] bg-[rgba(30,58,138,0.35)] font-medium text-[#D3DEFA]";
export function ParlaySlipButton({ dark = false }: { dark?: boolean }) {
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
      <div className={dark ? BANNER_PILL + BANNER_IDLE + " ml-auto min-w-0 max-w-full gap-1 pl-3 pr-1.5 [@container_(min-width:640px)]:gap-2 [@container_(min-width:640px)]:pl-[18px] [@container_(min-width:640px)]:pr-2" : "flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-soft"}>
        <span className={dark ? "truncate" : "text-muted-foreground"}>
          Discard {checkedCount} selected pick{checkedCount === 1 ? "" : "s"}?
        </span>
        <button
          onClick={() => setConfirmingDiscard(false)}
          className={"rounded-full py-1 text-xs font-medium " + (dark ? "flex-none px-2 text-[#D3DEFA] hover:bg-white/10 hover:text-white [@container_(min-width:640px)]:px-2.5" : "px-2.5 text-muted-foreground hover:bg-muted")}
        >
          Cancel
        </button>
        <button
          onClick={() => {
            setConfirmingDiscard(false);
            discardAdd();
          }}
          className={"rounded-full bg-red-600 py-1 text-xs font-medium text-white hover:bg-red-700 " + (dark ? "flex-none px-2 [@container_(min-width:640px)]:px-2.5" : "px-2.5")}
        >
          Discard
        </button>
      </div>
    );
  }

  return (
    <div className={"flex items-center gap-2" + (dark ? " ml-auto" : "")}>
      <button
        onClick={handleToggle}
        className={
          dark
            ? BANNER_BUTTON + "gap-2 [@container_(min-width:640px)]:gap-2.5 " + (addMode ? "border-[#2563EB] bg-[#2563EB] font-semibold text-white shadow-[0_0_14px_rgba(37,99,235,0.6)]" : BANNER_IDLE + " hover:text-white")
            : "rounded-full px-3.5 py-1.5 text-sm font-medium shadow-soft transition " +
              (addMode ? "bg-foreground text-background" : "bg-card text-muted-foreground hover:bg-muted")
        }
      >
        {dark && <ClipboardIcon className={"h-3.5 w-3.5 flex-none [@container_(min-width:640px)]:h-4 [@container_(min-width:640px)]:w-4" + (addMode ? "" : " text-[#9AD8FF]")} />}
        {label}
      </button>
      {addMode && checkedCount > 0 && (
        <button
          onClick={confirmAdd}
          className={
            dark
              ? BANNER_BUTTON + "border-white bg-white font-semibold text-[#011948] hover:bg-[#D3DEFA]"
              : "rounded-full bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-soft hover:bg-brand-700"
          }
        >
          Confirm
        </button>
      )}
    </div>
  );
}
