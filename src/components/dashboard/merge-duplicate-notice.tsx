"use client";

import { useEffect, useState } from "react";
import {
  mergeDuplicateHeadline,
  mergeDuplicateLines,
  mergeDuplicateStorageKey,
  type MergeDuplicateLine,
} from "@/lib/merge-duplicate-report";

// The duplicate picks a merge left under one capper - reported, never acted on.
export function MergeDuplicateList({ duplicates }: { duplicates: MergeDuplicateLine[] }) {
  if (duplicates.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
      <p className="font-medium">{mergeDuplicateHeadline(duplicates.length)}</p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
        {mergeDuplicateLines(duplicates).map((line) => (
          <li key={line} className="break-words">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

// On the surviving capper's page: shows the report a merge started from the
// other capper's profile left in sessionStorage, until dismissed.
export function MergeDuplicateNotice({ capperId }: { capperId: string }) {
  const [duplicates, setDuplicates] = useState<MergeDuplicateLine[]>([]);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(mergeDuplicateStorageKey(capperId));
      if (stored) setDuplicates(JSON.parse(stored) as MergeDuplicateLine[]);
    } catch {
      // No storage, or an unreadable entry: nothing to show.
    }
  }, [capperId]);

  if (duplicates.length === 0) return null;
  return (
    <div>
      <MergeDuplicateList duplicates={duplicates} />
      <button
        type="button"
        onClick={() => {
          try {
            window.sessionStorage.removeItem(mergeDuplicateStorageKey(capperId));
          } catch {
            // ignore
          }
          setDuplicates([]);
        }}
        className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Dismiss
      </button>
    </div>
  );
}
