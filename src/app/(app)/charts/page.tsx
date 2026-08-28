import { requireUser } from "@/server/auth";
import { getAllMlbTeamNames } from "@/server/data/mlb-stats";
import { ChartsModeSwitcher } from "@/components/charts/charts-mode-switcher";
import { getEntitlementsForUser } from "@/server/data/subscriptions";
import { UpgradeGate } from "@/components/billing/upgrade-gate";
import { MODEL_VARIABLES } from "@/lib/model-builder";
import { getCustomMetricVariables } from "@/server/data/custom-metrics";
import { getCappersForUser } from "@/server/data/cappers";
import { getSportsWithLeagues } from "@/server/data/picks";

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
  // The full variable catalog this user can chart - built-ins
  // (MODEL_VARIABLES, same for every user) plus this user's own uploaded
  // Custom Metrics (getCustomMetricVariables, per-user). Merged here, once,
  // server-side, and handed down as one prop - VariableLibrary and the two
  // workspaces never need to know which entries came from which source.
  const [customVariables, cappers, sports] = await Promise.all([
    getCustomMetricVariables(user.id, CHARTS_SPORT_KEY),
    getCappersForUser(user.id),
    getSportsWithLeagues(),
  ]);
  const variables = [...MODEL_VARIABLES, ...customVariables];

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Charts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a team and a variable to see its history - stats and tendencies grow one day at a time as the daily
          snapshot job runs, so recent variables may only show a day or two so far. Upload your own CSV metrics with
          Add Custom Metric to chart them right alongside the built-in ones.
        </p>
      </div>

      <ChartsModeSwitcher
        sportKey={CHARTS_SPORT_KEY}
        teamNames={teamNames}
        variables={variables}
        cappers={cappers}
        sports={sports}
      />
    </div>
  );
}
