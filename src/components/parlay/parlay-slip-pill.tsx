"use client";

// The /parlay banner's header pill: "Parlay slip · 3 picks · 2 games" - what
// the generator is working with. Read-only; the slip is edited on the card and
// on Live.
import { useParlayPool } from "@/components/parlay/parlay-pool-context";
import { ClipboardIcon } from "@/components/dashboard/cappers-icons";

export function ParlaySlipPill() {
  const { pool, targetedGames } = useParlayPool();
  const picks = pool.length;
  const games = targetedGames.length;
  return (
    <span className="ml-auto flex h-[34px] items-center gap-2 rounded-full border border-[rgba(96,140,255,0.28)] bg-[rgba(30,58,138,0.35)] px-3.5 text-[12.5px] font-medium text-[#D3DEFA] [@container_(min-width:640px)]:h-11 [@container_(min-width:640px)]:px-[18px] [@container_(min-width:640px)]:text-sm">
      <ClipboardIcon className="h-3.5 w-3.5 flex-none text-[#9AD8FF] [@container_(min-width:640px)]:h-4 [@container_(min-width:640px)]:w-4" />
      Parlay slip · {picks} pick{picks === 1 ? "" : "s"} · {games} game{games === 1 ? "" : "s"}
    </span>
  );
}
