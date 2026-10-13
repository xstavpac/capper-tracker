import { requireUser } from "@/server/auth";
import { CapperComparisonWorkspace } from "@/components/charts/capper-comparison-workspace";
import { getEntitlementsForUser } from "@/server/data/subscriptions";
import { UpgradeGate } from "@/components/billing/upgrade-gate";
import { getCappersForUser } from "@/server/data/cappers";
import { getSportsWithLeagues } from "@/server/data/picks";
import { ThemedPage } from "@/components/dashboard/themed-page";

export default async function ChartsPage() {
  const user = await requireUser();

  // Pro-only feature - checked server-side, never trusting client-side tier
  // info. See model-builder/page.tsx for the same pattern.
  const entitlements = await getEntitlementsForUser(user.id);
  if (!entitlements.hasFeature("charts")) {
    return (
      <ThemedPage>
        <UpgradeGate title="Charts is a Pro feature" description="Compare two cappers' results side by side." />
      </ThemedPage>
    );
  }

  const [cappers, sports] = await Promise.all([getCappersForUser(user.id), getSportsWithLeagues()]);

  // The typeface, backdrop and width of /cappers, /dashboard and /picks. The banner is drawn in
  // code by the workspace, which owns the filters it holds. The workspace reads an id and a name
  // of each capper and sport, so only those are sent to the browser.
  return (
    <ThemedPage>
      <CapperComparisonWorkspace cappers={cappers.map((c) => ({ id: c.id, name: c.name }))} sports={sports.map((s) => ({ id: s.id, name: s.name }))} />
    </ThemedPage>
  );
}
