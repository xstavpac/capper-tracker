"use client";

// Live's slip control, on the /live league row, left of the Feed / Grid toggle. Off: "Parlay slip · N" turns slip
// mode on (the checkboxes on every pick card and "Target game" on every game
// card). On: the slip-mode bar - "N picks · M games targeted", Exit, and
// "Send to generator →", which turns slip mode off and opens /parlay. The
// checkboxes write straight into the slip, so there is nothing to confirm or
// discard; leaving slip mode keeps the slip. A pick refused at the leg cap says
// "60 picks max" here.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParlayPool } from "@/components/parlay/parlay-pool-context";
import { ClipboardIcon, TicketIcon } from "@/components/dashboard/cappers-icons";
import { LIVE_PILL, LIVE_PILL_ON } from "@/components/live/live-pill-styles";
import { MAX_POOL_PICKS_MESSAGE } from "@/lib/parlay/leg-cap";

// The /live banner's pills (40px, as in design/page-banners-reference.html).
const BANNER_PILL = "flex h-10 items-center rounded-full border text-[13px] transition ";
const BANNER_BUTTON = BANNER_PILL + "flex-none px-3.5 ";
const BANNER_IDLE = "border-[color:var(--bv-pill-border)] bg-[var(--bv-pill-bg)] font-semibold text-[color:var(--bv-btn-text)]";

export function ParlaySlipButton() {
  const { slipSize, targetedGames, slipMode, enterSlipMode, exitSlipMode, sendToGenerator, overCapBy, dismissOverCap } = useParlayPool();
  const games = targetedGames.length;

  if (!slipMode) {
    return (
      <div className="flex h-11 items-center">
        <button type="button" onClick={enterSlipMode} className={LIVE_PILL + "live-seg live-seg-off !h-11"}>
          <TicketIcon className="h-[18px] w-[18px] flex-none" />
          {"Parlay slip" + (slipSize > 0 ? " · " + slipSize : "")}
        </button>
      </div>
    );
  }

  const summary = slipSize + " pick" + (slipSize === 1 ? "" : "s") + " · " + games + " game" + (games === 1 ? "" : "s") + " targeted";
  return (
    <div role="toolbar" aria-label="Slip mode" className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      {/* Phone (below 768px): the chip is the filled "on" pill and a tap on it leaves slip mode; Exit and Send are in the action bar (ParlaySlipActionBar). */}
      <button type="button" aria-pressed="true" aria-label={"Slip mode on, " + summary + ". Tap to exit."} onClick={exitSlipMode} className={LIVE_PILL + LIVE_PILL_ON + "!h-11 md:hidden"}>
        <ClipboardIcon className="h-[18px] w-[18px] flex-none" />
        {summary}
      </button>
      <span className={"max-md:hidden " + BANNER_PILL + "min-w-0 gap-2 border-[color:var(--bv-active)] bg-[var(--bv-active)] px-3.5 font-semibold text-white shadow-[0_0_14px_rgba(37,99,235,0.6)]"}>
        <ClipboardIcon className="h-4 w-4 flex-none" />
        <span className="truncate">{summary}</span>
      </span>
      {overCapBy !== null && (
        <span role="alert" className={"max-md:hidden " + BANNER_PILL + BANNER_IDLE + " gap-1 pl-3 pr-1.5"}>
          <span className="font-semibold text-[color:var(--bv-h1)]">{MAX_POOL_PICKS_MESSAGE}</span>
          <button type="button" onClick={dismissOverCap} className="rounded-full px-2 py-1 text-xs font-medium hover:bg-[var(--bv-pill-border)]/40 hover:text-[color:var(--bv-h1)]">
            OK
          </button>
        </span>
      )}
      <button type="button" onClick={exitSlipMode} className={"max-md:hidden " + BANNER_BUTTON + BANNER_IDLE + " hover:text-[color:var(--bv-h1)]"}>
        Exit
      </button>
      <Link href="/parlay" onClick={sendToGenerator} className={"max-md:hidden " + BANNER_BUTTON + SEND_STYLE}>
        Send to generator →
      </Link>
    </div>
  );
}

const SEND_STYLE = "border-transparent bg-[#2563EB] font-semibold text-white hover:bg-[#1D4ED8] dark:border-white dark:bg-white dark:text-banner dark:hover:bg-[#D3DEFA]";

// Phone only (below 768px), while slip mode is on: a floating card just above the bottom tab bar with the
// live summary, Exit and Send to generator - the same handlers as the inline buttons. It slides up and
// fades in on enter and back out on exit (no motion under prefers-reduced-motion). While it is up, <body>
// carries data-slip-bar so the page gets bottom padding (globals.css) and the last tiles clear it.
const BAR_EXIT_MS = 200;
export function ParlaySlipActionBar() {
  const { slipSize, targetedGames, slipMode, exitSlipMode, sendToGenerator, overCapBy, dismissOverCap } = useParlayPool();
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (slipMode) {
      setMounted(true);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const id = setTimeout(() => setMounted(false), BAR_EXIT_MS);
    return () => clearTimeout(id);
  }, [slipMode]);
  useEffect(() => {
    if (!mounted) return;
    document.body.setAttribute("data-slip-bar", "");
    return () => document.body.removeAttribute("data-slip-bar");
  }, [mounted]);
  if (!mounted) return null;

  const games = targetedGames.length;
  return (
    <div
      role="toolbar"
      aria-label="Slip actions"
      className={
        "fixed inset-x-3 bottom-[calc(56px+env(safe-area-inset-bottom)+8px)] z-40 flex flex-col gap-2 rounded-2xl border border-[#E3E8F0] bg-white p-3 shadow-[0_8px_28px_rgba(5,11,28,.18)] transition duration-200 ease-out motion-reduce:transition-none md:hidden dark:border-border dark:bg-card " +
        (shown && slipMode ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0 motion-reduce:translate-y-0")
      }
    >
      {overCapBy !== null && (
        <div role="alert" className="flex items-center justify-between gap-2 text-[13px] font-semibold text-[color:var(--bv-h1)]">
          <span>{MAX_POOL_PICKS_MESSAGE}</span>
          <button type="button" onClick={dismissOverCap} className="rounded-full px-2 py-1 text-xs font-medium">
            OK
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span aria-live="polite" className="min-w-0 flex-1 text-[14px] font-semibold leading-tight text-[#0b1838] dark:text-card-foreground">
          {slipSize} pick{slipSize === 1 ? "" : "s"} · {games} game{games === 1 ? "" : "s"}
        </span>
        <button type="button" onClick={exitSlipMode} className={BANNER_BUTTON + BANNER_IDLE + " gap-1.5 !px-3"}>
          <span aria-hidden="true">✕</span>
          Exit
        </button>
        {slipSize === 0 ? (
          <span aria-disabled="true" className={BANNER_BUTTON + "cursor-not-allowed border-transparent bg-[#2563EB] font-semibold text-white opacity-50 dark:bg-white dark:text-banner"}>
            Send to generator →
          </span>
        ) : (
          <Link href="/parlay" onClick={sendToGenerator} className={BANNER_BUTTON + SEND_STYLE}>
            Send to generator →
          </Link>
        )}
      </div>
    </div>
  );
}
