"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toggleFavoriteCapperAction } from "@/server/actions/cappers";
import { StarIcon } from "@/components/dashboard/star-icon";

// Optimistic star toggle - flips instantly on click, confirms/reverts against the
// server action's real result, then refreshes the server-rendered page (which is
// where favorites-only filtering and the favorites summary come from).
export function FavoriteStar({ capperId, isFavorite }: { capperId: string; isFavorite: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const shown = optimistic ?? isFavorite;

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    setOptimistic(!shown);
    const result = await toggleFavoriteCapperAction(capperId);
    setPending(false);
    if (!result.success) {
      setOptimistic(shown); // revert
      return;
    }
    setOptimistic(result.isFavorite);
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={shown ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={shown}
      title={shown ? "Click to remove from favorites" : "Click to favorite this capper"}
      className={"shrink-0 transition hover:scale-110 " + (shown ? "text-amber-400" : "text-muted-foreground/50 hover:text-amber-400")}
    >
      <StarIcon filled={shown} />
    </button>
  );
}
