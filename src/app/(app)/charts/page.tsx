import { requireUser } from "@/server/auth";
import { CapperComparisonWorkspace } from "@/components/charts/capper-comparison-workspace";
import { getEntitlementsForUser } from "@/server/data/subscriptions";
import { UpgradeGate } from "@/components/billing/upgrade-gate";
import { getCappersForUser } from "@/server/data/cappers";
import { getSportsWithLeagues } from "@/server/data/picks";
import { ImageBanner } from "@/components/ui/ImageBanner";
import chartsBanner from "../../../../public/banners/charts.png";

export default async function ChartsPage() {
  const user = await requireUser();

  // Pro-only feature - checked server-side, never trusting client-side tier
  // info. See model-builder/page.tsx for the same pattern.
  const entitlements = await getEntitlementsForUser(user.id);
  if (!entitlements.hasFeature("charts")) {
    return (
      <div className="mx-auto max-w-[1400px]">
        <UpgradeGate title="Charts is a Pro feature" description="Compare two cappers' results side by side." />
      </div>
    );
  }

  const [cappers, sports] = await Promise.all([getCappersForUser(user.id), getSportsWithLeagues()]);

  return (
    <div className="mx-auto max-w-[1400px]">
      <ImageBanner src={chartsBanner} title="Charts" priority />
      <CapperComparisonWorkspace cappers={cappers} sports={sports} />
    </div>
  );
}
