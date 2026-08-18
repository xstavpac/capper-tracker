"use client";

import { useState } from "react";
import { updatePickStatusAction } from "@/server/actions/picks";
import type { PickStatus } from "@prisma/client";

export function PickStatusButtons({ pickId, status }: { pickId: string; status: PickStatus }) {
  const [current, setCurrent] = useState(status);
  const [updating, setUpdating] = useState(false);

  if (current !== "PENDING") {
    const label =
      current === "WIN" ? "Win" : current === "LOSS" ? "Loss" : current === "PUSH" ? "Push" : "Cancelled";
    const colorClass =
      current === "WIN"
        ? "text-emerald-600 dark:text-emerald-400"
        : current === "LOSS"
          ? "text-red-600 dark:text-red-400"
          : "text-muted-foreground";
    return <span className={"text-sm font-medium " + colorClass}>{label}</span>;
  }

  async function setStatus(newStatus: PickStatus) {
    setUpdating(true);
    const result = await updatePickStatusAction(pickId, newStatus);
    setUpdating(false);
    if (result.success) {
      setCurrent(newStatus);
    }
  }

  return (
    <div className="flex gap-1">
      <button
        disabled={updating}
        onClick={() => setStatus("WIN")}
        className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-400 dark:hover:bg-emerald-500/25 disabled:opacity-50"
      >
        Win
      </button>
      <button
        disabled={updating}
        onClick={() => setStatus("LOSS")}
        className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-100 dark:bg-red-500/15 dark:text-red-400 dark:hover:bg-red-500/25 disabled:opacity-50"
      >
        Loss
      </button>
      <button
        disabled={updating}
        onClick={() => setStatus("PUSH")}
        className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-border disabled:opacity-50"
      >
        Push
      </button>
    </div>
  );
}
