import { requireUser } from "@/server/auth";
import { getAllMlbTeamNames } from "@/server/data/mlb-stats";
import { ChartsWorkspace } from "@/components/charts/charts-workspace";

// MLB-only, matching the model builder - every chartable variable
// (team_stats/team_tendencies) is sourced from MLB-specific tables.
const CHARTS_SPORT_KEY = "baseball_mlb";

export default async function ChartsPage() {
  await requireUser();
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
