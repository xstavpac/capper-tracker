import { requireUser } from "@/server/auth";
import { getCappersForUser, getPlanStatus, getWeeklyCapperLeaderboard } from "@/server/data/cappers";
import { LIVE_SPORTS } from "@/server/data/odds";
import { chipSetForLeague, PICK_CATEGORY_LABELS, type PickCategoryKey } from "@/server/data/stats";
import { CapperForm } from "@/components/dashboard/capper-form";
import { WeeklyLeaderboard } from "@/components/dashboard/weekly-leaderboard";

const SOURCE_LABELS: Record<string, string> = {
  TWITTER: "Twitter / X",
  DISCORD: "Discord",
  TELEGRAM: "Telegram",
  DUBCLUB: "DubClub",
  INSTAGRAM: "Instagram",
  FRIEND: "Friend",
  OTHER: "Other",
};

const LEAGUES = LIVE_SPORTS.map((s) => s.label);

function pillClass(isActive: boolean) {
  return (
    "rounded-full px-4 py-1.5 text-sm font-medium " +
    (isActive ? "bg-brand-600 text-white" : "bg-white text-gray-600 shadow-soft hover:bg-gray-50")
  );
}

function chipClass(isActive: boolean) {
  return (
    "rounded-full px-3 py-1 text-xs font-medium " +
    (isActive ? "bg-gray-900 text-white" : "bg-white text-gray-500 shadow-soft hover:bg-gray-50")
  );
}

function buildHref(league: string | undefined, category: string | undefined) {
  const params = new URLSearchParams();
  if (league) params.set("league", league);
  if (category) params.set("category", category);
  const qs = params.toString();
  return "/cappers" + (qs ? "?" + qs : "");
}

export default async function CappersPage({
  searchParams,
}: {
  searchParams: { league?: string; category?: string };
}) {
  const user = await requireUser();

  const league = LEAGUES.includes(searchParams.league ?? "") ? searchParams.league : undefined;
  const chipSet = chipSetForLeague(league ?? "");
  const category = chipSet.includes(searchParams.category as PickCategoryKey)
    ? (searchParams.category as PickCategoryKey)
    : undefined;

  const [cappers, planStatus, leaderboard] = await Promise.all([
    getCappersForUser(user.id, { sportName: league, category }),
    getPlanStatus(user.id),
    getWeeklyCapperLeaderboard(user.id, { sportName: league, category }),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Cappers</h1>
          <p className="mt-1 text-sm text-gray-500">
            {planStatus.capperCount + " capper" + (planStatus.capperCount === 1 ? "" : "s")}
          </p>
        </div>
        <CapperForm atLimit={false} />
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <a href={buildHref(undefined, undefined)} className={pillClass(!league)}>
          All leagues
        </a>
        {LEAGUES.map((l) => (
          <a key={l} href={buildHref(l, undefined)} className={pillClass(league === l)}>
            {l}
          </a>
        ))}
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        <a href={buildHref(league, undefined)} className={chipClass(!category)}>
          All bet types
        </a>
        {chipSet.map((c) => (
          <a key={c} href={buildHref(league, c)} className={chipClass(category === c)}>
            {PICK_CATEGORY_LABELS[c]}
          </a>
        ))}
      </div>

      <WeeklyLeaderboard entries={leaderboard} />

      {cappers.length === 0 ? (
        <div className="rounded-card bg-white p-10 text-center shadow-soft">
          <p className="text-sm text-gray-400">
            {league || category
              ? "No cappers have picks matching this filter."
              : "No cappers yet - add the first person or channel you follow for picks."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {cappers.map((capper) => (
            <a
            
              key={capper.id}
              href={"/cappers/" + capper.id}
              className="rounded-card bg-white p-4 shadow-soft transition hover:shadow-md"
            >
              <div className="flex items-center gap-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-medium text-white"
                  style={{ backgroundColor: capper.colorTag ?? "#3B82F6" }}
                >
                  {capper.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div className="font-medium">{capper.name}</div>
                  <div className="text-xs text-gray-500">
                    {capper.source === "OTHER" && capper.customSource
                      ? capper.customSource
                      : SOURCE_LABELS[capper.source]}
                  </div>
                </div>
              </div>
              {capper.sportSpecialization && (
                <div className="mt-3 text-xs text-gray-500">
                  Specializes in {capper.sportSpecialization}
                </div>
              )}
              {capper.notes && (
                <p className="mt-2 line-clamp-2 text-xs text-gray-400">{capper.notes}</p>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
