import { requireUser } from "@/server/auth";
import { getAllMlbTeamNames } from "@/server/data/mlb-stats";
import { ChartsWorkspace } from "@/components/charts/charts-workspace";
import { getEntitlementsForUser } from "@/server/data/subscriptions";
import { UpgradeGate } from "@/components/billing/upgrade-gate";

// MLB-only, matching the model builder - every chartable variable
// (team_stats/team_tendencies) is sourced from MLB-specific tables.
const CHARTS_SPORT_KEY = "baseball_mlb";

export default async function ChartsPage() {
  const user = await requireUser();

  // Pro-only feature - checked server-side, never trusting client-side tier
  // info. See model-builder/page.tsx for the same pattern.
  const entitlements = await getEntitlementsForUser(user.id);
  if (!entitlements.hasFeature("charts")) {
    return (
      <div className="mx-auto max-w-[1400px]">
        <UpgradeGate
          title="Charts is a Pro feature"
          description="Browse any team's stat or tendency history over time, and overlay multiple variables."
        />
      </div>
    );
  }

  const teamNames = getAllMlbTeamNames();

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Charts</h1>
        <p className="mt-1 text-sm text-gray-500">
          Pick a team and a variable to see its history - stats and tendencies grow one day at a time as the daily
          snapshot job runs, so recent variables may only show a day or two so far.
        </p>
      </div>

      <ChartsWorkspace sportKey={CHARTS_SPORT_KEY} teamNames={teamNames} />
    </div>
  );
}
