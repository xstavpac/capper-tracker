import { Suspense } from "react";
import { SlateBar, SlateBarSkeleton } from "@/components/layout/slate-bar";
import { getSlateCounts } from "@/server/data/slate-counts";

async function SlateBarData() {
  const counts = await getSlateCounts();
  return <SlateBar counts={counts} />;
}

// Stream in under the header so the page is not held up by the score feeds; the skeletons keep the
// heights meanwhile. Mobile only (below 1024px); desktop has no Slate Bar.
export function SlateBarLoader() {
  return (
    <Suspense fallback={<SlateBarSkeleton />}>
      <SlateBarData />
    </Suspense>
  );
}
