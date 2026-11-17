import { Suspense } from "react";
import { SlateBar, SlateBarSkeleton, SlateChipsRow, SlateChipsSkeleton } from "@/components/layout/slate-bar";
import { getSlateCounts } from "@/server/data/slate-counts";

async function SlateBarData() {
  const counts = await getSlateCounts();
  return <SlateBar counts={counts} />;
}

async function SlateChipsData() {
  const counts = await getSlateCounts();
  return <SlateChipsRow counts={counts} />;
}

// Stream in under the header so the page is not held up by the score feeds; the skeletons keep the
// heights meanwhile. SlateBarLoader: the full bar (date, chips, stats), below 1024px. SlateChipsLoader:
// the chips alone, from 1024px.
export function SlateBarLoader() {
  return (
    <Suspense fallback={<SlateBarSkeleton />}>
      <SlateBarData />
    </Suspense>
  );
}

export function SlateChipsLoader() {
  return (
    <Suspense fallback={<SlateChipsSkeleton />}>
      <SlateChipsData />
    </Suspense>
  );
}
