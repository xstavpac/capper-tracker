"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { dateStepHref } from "@/lib/picks-header";

function Arrow({ dir }: { dir: "back" | "forward" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
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

const control =
  "border border-[#DADDE5] bg-white text-foreground transition hover:bg-[#F5F6FA] disabled:opacity-60 dark:border-border dark:bg-card dark:hover:bg-muted";
const arrowClass = "inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] " + control;

// The day row under the banner: ‹ Tuesday, Sep 29 › 89 picks, and "Jump to today" on the right
// whenever the page is on any other day. The arrows step the same `date` URL param the date chip
// writes. In range mode it shows the range text and no arrows.
export function DateNavigator({
  dateKey,
  label,
  isRange,
  isToday,
  countText,
}: {
  dateKey: string;
  label: string;
  isRange: boolean;
  isToday: boolean;
  countText: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const step = (days: number) =>
    startTransition(() => router.push(dateStepHref(pathname, params.toString(), dateKey, days)));

  // Today is the page's default day: dropping the date params lands on it, other filters kept.
  const jumpToToday = () => {
    const next = new URLSearchParams(params.toString());
    for (const k of ["date", "startDate", "endDate"]) next.delete(k);
    const qs = next.toString();
    startTransition(() => router.push(qs ? pathname + "?" + qs : pathname));
  };

  return (
    <div className={"flex flex-wrap items-center justify-between gap-x-3 gap-y-2 " + (pending ? "opacity-70" : "")}>
      <div className="flex min-w-0 items-center gap-2">
        {!isRange && (
          <button type="button" aria-label="Previous day" onClick={() => step(-1)} className={arrowClass}>
            <Arrow dir="back" />
          </button>
        )}
        <span className="min-w-0 text-[15px] font-semibold tracking-[-0.01em] text-foreground">{label}</span>
        {!isRange && (
          <button type="button" aria-label="Next day" onClick={() => step(1)} className={arrowClass}>
            <Arrow dir="forward" />
          </button>
        )}
        <span className="ml-1 whitespace-nowrap text-[13px] font-medium tabular-nums text-[#5B6275] dark:text-muted-foreground">{countText}</span>
      </div>
      {!isToday && (
        <button type="button" onClick={jumpToToday} className={"h-[34px] shrink-0 whitespace-nowrap rounded-[10px] px-3 text-[13px] font-semibold " + control}>
          Jump to today
        </button>
      )}
    </div>
  );
}
