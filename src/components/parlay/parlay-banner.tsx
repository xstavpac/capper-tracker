import { PageBanner } from "@/components/dashboard/page-banner";
import { ParlaySlipPill } from "@/components/parlay/parlay-slip-pill";

// The /parlay banner: the title and motto, with the Parlay slip pill ("3 picks · 2 games") under them.
export function ParlayBanner() {
  return (
    <PageBanner variant="parlay" title="Parlay Generator" motto="BUILD · HEDGE · FADE">
      <ParlaySlipPill />
    </PageBanner>
  );
}
