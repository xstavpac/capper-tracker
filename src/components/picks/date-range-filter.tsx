"use client";

import { useState } from "react";

const DATE_INPUT_CLASS =
  "w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground sm:w-auto";

// Single native <input type="date"> by default (matches how every other
// filter on this page - capper/sport/betType/status - is a plain native
// control inside the page's own GET <form>, no client-side data fetching
// here, just which inputs are visible). Toggling "Date range" swaps in a
// second date input; toggling back drops it, so submitting the surrounding
// form always sends exactly one of `date` or `startDate`+`endDate`, never
// both - the server only needs to handle one shape at a time (see
// PicksPage's resolveDateFilter).
export function DateRangeFilter({
  initialDate,
  initialStartDate,
  initialEndDate,
  initialIsRange,
}: {
  initialDate: string;
  initialStartDate: string;
  initialEndDate: string;
  initialIsRange: boolean;
}) {
  const [isRange, setIsRange] = useState(initialIsRange);

  return (
    <div className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-1 sm:contents">
      {isRange ? (
        <div className="flex w-full items-center gap-1.5 sm:w-auto">
          <input type="date" name="startDate" defaultValue={initialStartDate} className={DATE_INPUT_CLASS} />
          <span className="text-sm text-muted-foreground">to</span>
          <input type="date" name="endDate" defaultValue={initialEndDate} className={DATE_INPUT_CLASS} />
        </div>
      ) : (
        <input type="date" name="date" defaultValue={initialDate} className={DATE_INPUT_CLASS} />
      )}

      <button
        type="button"
        onClick={() => setIsRange(!isRange)}
        className="text-sm text-brand-600 hover:text-brand-700"
      >
        {isRange ? "Single day" : "Date range"}
      </button>
    </div>
  );
}
