"use client";

// Live's slip control, in the /live banner. Off: "Parlay slip · N" turns slip
// mode on (the checkboxes on every pick card and "Target game" on every game
// card). On: the slip-mode bar - "N picks · M games targeted", Exit, and
// "Send to generator →", which turns slip mode off and opens /parlay. The
// checkboxes write straight into the slip, so there is nothing to confirm or
// discard; leaving slip mode keeps the slip. A pick refused at the leg cap says
// "60 picks max" here.
import Link from "next/link";
import { useParlayPool } from "@/components/parlay/parlay-pool-context";
import { ClipboardIcon, TicketIcon } from "@/components/dashboard/cappers-icons";
import { LIVE_PILL, LIVE_PILL_OFF } from "@/components/live/live-pill-styles";
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
        <button type="button" onClick={enterSlipMode} className={LIVE_PILL + LIVE_PILL_OFF + "!h-11"}>
          <TicketIcon className="h-[18px] w-[18px] flex-none" />
          {"Parlay slip" + (slipSize > 0 ? " · " + slipSize : "")}
        </button>
      </div>
    );
  }

  return (
    <div role="toolbar" aria-label="Slip mode" className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <span className={BANNER_PILL + "min-w-0 gap-2 border-[color:var(--bv-active)] bg-[var(--bv-active)] px-3.5 font-semibold text-white shadow-[0_0_14px_rgba(37,99,235,0.6)]"}>
        <ClipboardIcon className="h-4 w-4 flex-none" />
        <span className="truncate">
          {slipSize} pick{slipSize === 1 ? "" : "s"} · {games} game{games === 1 ? "" : "s"} targeted
        </span>
      </span>
      {overCapBy !== null && (
        <span role="alert" className={BANNER_PILL + BANNER_IDLE + " gap-1 pl-3 pr-1.5"}>
          <span className="font-semibold text-[color:var(--bv-h1)]">{MAX_POOL_PICKS_MESSAGE}</span>
          <button type="button" onClick={dismissOverCap} className="rounded-full px-2 py-1 text-xs font-medium hover:bg-[var(--bv-pill-border)]/40 hover:text-[color:var(--bv-h1)]">
            OK
          </button>
        </span>
      )}
      <button type="button" onClick={exitSlipMode} className={BANNER_BUTTON + BANNER_IDLE + " hover:text-[color:var(--bv-h1)]"}>
        Exit
      </button>
      <Link href="/parlay" onClick={sendToGenerator} className={BANNER_BUTTON + "border-transparent bg-[#2563EB] font-semibold text-white hover:bg-[#1D4ED8] dark:border-white dark:bg-white dark:text-banner dark:hover:bg-[#D3DEFA]"}>
        Send to generator →
      </Link>
    </div>
  );
}
