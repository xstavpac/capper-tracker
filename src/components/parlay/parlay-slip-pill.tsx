"use client";

// The /parlay banner's header pill: "Parlay slip · 3 picks · 2 games" - what
// the generator is working with. Read-only; the slip is edited on the card and
// on Live.
import { useParlayPool } from "@/components/parlay/parlay-pool-context";
import { ClipboardIcon } from "@/components/dashboard/cappers-icons";
import { BANNER_PILL } from "@/components/dashboard/page-banner";

export function ParlaySlipPill() {
  const { pool, targetedGames } = useParlayPool();
  const picks = pool.length;
  const games = targetedGames.length;
  return (
    <span className={BANNER_PILL}>
      <ClipboardIcon className="h-4 w-4 flex-none" />
      Parlay slip · {picks} pick{picks === 1 ? "" : "s"} · {games} game{games === 1 ? "" : "s"}
    </span>
  );
}
