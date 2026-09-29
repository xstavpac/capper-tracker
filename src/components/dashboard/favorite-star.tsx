"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toggleFavoriteCapperAction } from "@/server/actions/cappers";

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 2}
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.5l2.9 6.3 6.9.7-5.2 4.7 1.6 6.8L12 17.6l-6.2 3.4 1.6-6.8-5.2-4.7 6.9-.7z" />
    </svg>
  );
}

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
