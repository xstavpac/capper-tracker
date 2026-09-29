"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { dateStepHref } from "@/lib/picks-header";

function Arrow({ dir }: { dir: "back" | "forward" }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d={dir === "back" ? "M7.5 2.5L4 6l3.5 3.5" : "M4.5 2.5L8 6 4.5 9.5"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const arrowClass =
  "inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-60";

// Subtitle under "Picks": ‹ Tuesday, Sep 29 › · 89 picks. The arrows step the
// same `date` URL param the date chip writes. In range mode it shows the range
// text and no arrows.
export function DateNavigator({
  dateKey,
  label,
  isRange,
  countText,
}: {
  dateKey: string;
  label: string;
  isRange: boolean;
  countText: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const step = (days: number) =>
    startTransition(() => router.push(dateStepHref(pathname, params.toString(), dateKey, days)));

  return (
    <div className={"flex items-center gap-1 text-sm text-muted-foreground " + (pending ? "opacity-70" : "")}>
      {!isRange && (
        <button type="button" aria-label="Previous day" onClick={() => step(-1)} className={arrowClass}>
          <Arrow dir="back" />
        </button>
      )}
      <span>{label}</span>
      {!isRange && (
        <button type="button" aria-label="Next day" onClick={() => step(1)} className={arrowClass}>
          <Arrow dir="forward" />
        </button>
      )}
      <span>{"· " + countText}</span>
    </div>
  );
}
