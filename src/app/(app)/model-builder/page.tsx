import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { isModelBuilderEnabled } from "@/lib/feature-flags";
import { getUserModels } from "@/server/data/models";
import { getOddsForSport } from "@/server/data/odds";
import { sameEasternDay } from "@/lib/dates";
import { parseModelBuilderPrefill } from "@/lib/model-builder-links";
import { ModelBuilderClient } from "@/components/model-builder/model-builder-client";

// MLB-only for v1 - every variable in the catalog (team tendencies, team/
// pitcher stats, odds/market) is sourced from MLB-specific APIs.
const MODEL_BUILDER_SPORT_KEY = "baseball_mlb";

export default async function ModelBuilderPage({
  searchParams,
}: {
  searchParams: { variableId?: string; side?: string };
}) {
  // Flag off -> the route itself 404s, not just a hidden nav item - hitting
  // /model-builder directly while disabled must behave as if the route
  // doesn't exist.
  if (!isModelBuilderEnabled()) notFound();

  const prefill = parseModelBuilderPrefill(searchParams);
  const user = await requireUser();

  const [savedModels, allOdds] = await Promise.all([
    getUserModels(user.id),
    getOddsForSport(MODEL_BUILDER_SPORT_KEY),
  ]);

  // Same "today or later" filter as the Live page - a once-daily odds cache
  // can still hold a strictly-past game late in the day.
  const now = new Date();
  const games = allOdds
    .filter((g) => {
      const gameDate = new Date(g.commenceTime);
      return sameEasternDay(gameDate, now) || gameDate > now;
    })
    .map((g) => ({ id: g.id, homeTeam: g.homeTeam, awayTeam: g.awayTeam, commenceTime: g.commenceTime }));

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Build Your Own Model</h1>
        <p className="mt-1 text-sm text-gray-500">
          Combine stats and market data into a rule-based model, then preview it against real MLB games.
        </p>
      </div>

      <ModelBuilderClient sportKey={MODEL_BUILDER_SPORT_KEY} savedModels={savedModels} games={games} prefillCondition={prefill} />
    </div>
  );
}
