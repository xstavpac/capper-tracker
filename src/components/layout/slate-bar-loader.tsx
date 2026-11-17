import { Suspense } from "react";
import { SlateBar, SlateBarSkeleton } from "@/components/layout/slate-bar";
import { getSlateCounts } from "@/server/data/slate-counts";

async function SlateBarData() {
  const counts = await getSlateCounts();
  return <SlateBar counts={counts} />;
}

// Streams in under the header so the page is not held up by the score feeds; the skeleton keeps the
// bar's height meanwhile.
export function SlateBarLoader() {
  return (
    <Suspense fallback={<SlateBarSkeleton />}>
      <SlateBarData />
    </Suspense>
  );
}
