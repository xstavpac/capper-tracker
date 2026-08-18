"use client";

import { useState, Children, type ReactNode } from "react";
import { CONDENSED_COUNT, EXPANDABLE_ROWS_MAX } from "@/components/dashboard/expandable-rows-constants";

// Shows the first CONDENSED_COUNT rows with a "See more" button beneath -
// clicking it reveals up to EXPANDABLE_ROWS_MAX total in place (no modal, no
// navigation) and flips the button to "Show less". Rows are pre-rendered by
// the (Server Component) caller and passed as `children` - functions can't
// cross the server/client boundary as props, but pre-rendered elements can.
// Each instance owns its own expanded state, so six of these on the same
// Dashboard page (one per Trending Cappers panel) expand/collapse
// independently. The button only renders when there's actually more than
// CONDENSED_COUNT rows - a panel with 2-3 entries never gets a useless
// "See more".
export function ExpandableRows({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const all = Children.toArray(children);
  const visible = all.slice(0, expanded ? EXPANDABLE_ROWS_MAX : CONDENSED_COUNT);

  return (
    <>
      {visible}
      {all.length > CONDENSED_COUNT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 w-full rounded-full border border-border py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted"
        >
          {expanded ? "Show less" : "See more"}
        </button>
      )}
    </>
  );
}
