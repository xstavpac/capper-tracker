"use client";

// Live's slip control, in the /live banner. Off: "Parlay slip · N" turns slip
// mode on (the checkboxes on every pick card and "Target game" on every game
// card). On: the slip-mode bar - "N picks · M games targeted", Exit, and
// "Send to generator →", which turns slip mode off and opens /parlay. The
// checkboxes write straight into the slip, so there is nothing to confirm or
// discard; leaving slip mode keeps the slip. A pick refused at the leg cap says
// "25 legs max" here.
import Link from "next/link";
import { useParlayPool } from "@/components/parlay/parlay-pool-context";
import { ClipboardIcon } from "@/components/dashboard/cappers-icons";
import { MAX_PARLAY_LEGS_MESSAGE } from "@/lib/parlay/leg-cap";

// The navy /live banner's pills: 34px, or 44px where the banner is 640px wide or more.
const BANNER_PILL = "flex h-[34px] items-center rounded-full border text-[12.5px] transition [@container_(min-width:640px)]:h-11 [@container_(min-width:640px)]:text-sm ";
const BANNER_BUTTON = BANNER_PILL + "flex-none px-3.5 [@container_(min-width:640px)]:px-[18px] ";
const BANNER_IDLE = "border-[rgba(96,140,255,0.28)] bg-[rgba(30,58,138,0.35)] font-medium text-[#D3DEFA]";

export function ParlaySlipButton() {
  const { slipSize, targetedGames, slipMode, enterSlipMode, exitSlipMode, sendToGenerator, overCapBy, dismissOverCap } = useParlayPool();
  const games = targetedGames.length;

  if (!slipMode) {
    return (
      <div className="ml-auto flex items-center gap-2">
        <button type="button" onClick={enterSlipMode} className={BANNER_BUTTON + "gap-2 [@container_(min-width:640px)]:gap-2.5 " + BANNER_IDLE + " hover:text-white"}>
          <ClipboardIcon className="h-3.5 w-3.5 flex-none text-[#9AD8FF] [@container_(min-width:640px)]:h-4 [@container_(min-width:640px)]:w-4" />
          {"Parlay slip" + (slipSize > 0 ? " · " + slipSize : "")}
        </button>
      </div>
    );
  }

  return (
    <div role="toolbar" aria-label="Slip mode" className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <span className={BANNER_PILL + "min-w-0 gap-2 border-[#2563EB] bg-[#2563EB] px-3.5 font-semibold text-white shadow-[0_0_14px_rgba(37,99,235,0.6)] [@container_(min-width:640px)]:px-[18px]"}>
        <ClipboardIcon className="h-3.5 w-3.5 flex-none [@container_(min-width:640px)]:h-4 [@container_(min-width:640px)]:w-4" />
        <span className="truncate">
          {slipSize} pick{slipSize === 1 ? "" : "s"} · {games} game{games === 1 ? "" : "s"} targeted
        </span>
      </span>
      {overCapBy !== null && (
        <span role="alert" className={BANNER_PILL + BANNER_IDLE + " gap-1 pl-3 pr-1.5"}>
          <span className="font-semibold text-white">{MAX_PARLAY_LEGS_MESSAGE}</span>
          <button type="button" onClick={dismissOverCap} className="rounded-full px-2 py-1 text-xs font-medium hover:bg-white/10 hover:text-white">
            OK
          </button>
        </span>
      )}
      <button type="button" onClick={exitSlipMode} className={BANNER_BUTTON + BANNER_IDLE + " hover:text-white"}>
        Exit
      </button>
      <Link href="/parlay" onClick={sendToGenerator} className={BANNER_BUTTON + "border-white bg-white font-semibold text-banner hover:bg-[#D3DEFA]"}>
        Send to generator →
      </Link>
    </div>
  );
}
