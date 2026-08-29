import { requireUser } from "@/server/auth";
import { prisma } from "@/lib/prisma";
import { getAllMlbTeamNames } from "@/server/data/mlb-stats";
import { getAllNflTeamNames } from "@/server/data/nfl-team-stats";
import { ChartsModeSwitcher, type ChartsSportData } from "@/components/charts/charts-mode-switcher";
import { getEntitlementsForUser } from "@/server/data/subscriptions";
import { UpgradeGate } from "@/components/billing/upgrade-gate";
import { MODEL_VARIABLES } from "@/lib/model-builder";
import { getCustomMetricVariables } from "@/server/data/custom-metrics";
import { getCappersForUser } from "@/server/data/cappers";
import { getSportsWithLeagues } from "@/server/data/picks";

const MLB_KEY = "baseball_mlb";
const NFL_KEY = "americanfootball_nfl";

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

  // One parallel batch. The NFL additions (this user's NFL custom metrics
  // and the NflTeamStatSnapshot existence check) ride along with the calls
  // that were already here - measured to add no wall-clock latency over the
  // previous MLB-only fetch, since every query is round-trip-latency-bound
  // and they run concurrently. Both sports are prepared up front and handed
  // down; the client toggle just picks which set to show.
  const [mlbCustom, nflCustom, nflHasAnyData, cappers, sports] = await Promise.all([
    getCustomMetricVariables(user.id, MLB_KEY),
    getCustomMetricVariables(user.id, NFL_KEY),
    prisma.nflTeamStatSnapshot.findFirst({ select: { id: true } }).then((row) => row !== null),
    getCappersForUser(user.id),
    getSportsWithLeagues(),
  ]);

  // Per sport: the team selector list plus the variable catalog already
  // narrowed to that sport (built-ins by ModelVariableDef.sport, custom
  // metrics by the sportKey they were uploaded under) and merged - so the
  // workspaces and VariableLibrary never see the other sport's variables.
  const sportOptions: ChartsSportData[] = [
    {
      key: MLB_KEY,
      label: "MLB",
      teamNames: getAllMlbTeamNames(),
      variables: [...MODEL_VARIABLES.filter((v) => v.sport === MLB_KEY), ...mlbCustom],
    },
    {
      key: NFL_KEY,
      label: "NFL",
      teamNames: getAllNflTeamNames(),
      variables: [...MODEL_VARIABLES.filter((v) => v.sport === NFL_KEY), ...nflCustom],
    },
  ];

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Charts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a sport, a team, and a variable to see its history - stats and tendencies fill in over time as games are
          played and the snapshot jobs run, so recent variables may only show a few points so far. Upload your own CSV
          metrics with Add Custom Metric to chart them right alongside the built-in ones.
        </p>
      </div>

      <ChartsModeSwitcher
        sportOptions={sportOptions}
        nflHasAnyData={nflHasAnyData}
        cappers={cappers}
        sports={sports}
      />

      {/* Data-source attribution. The nflverse credit is a CC-BY-4.0 license
          requirement, not optional - it must name the source, link the
          license, and indicate the data is adapted (we join/derive rather
          than reproduce verbatim). */}
      <p className="mt-8 text-xs text-muted-foreground">
        MLB team stats via the MLB Stats API. NFL team stats derived from{" "}
        <a
          href="https://github.com/nflverse/nflverse-data"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          nflverse
        </a>{" "}
        data, licensed{" "}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          CC-BY-4.0
        </a>
        .
      </p>
    </div>
  );
}
