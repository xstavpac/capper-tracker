import { prisma } from "@/lib/prisma";
import { startOfEasternDay } from "@/lib/dates";
import { LIVE_SPORTS } from "@/server/data/odds";
import { pickCategory, PICK_CATEGORY_LABELS, type PickCategoryKey } from "@/server/data/stats";
import { getCapperCategoryRecord } from "@/server/data/picks";

// No minimum sample size by design (a 1-1 capper qualifies) - the actual
// wins/losses/pushes always accompany the percentage in the UI so the user
// can judge sample size themselves rather than the feature deciding for them.
const QUALIFYING_WIN_PCT = 55;

export type SharpMoneyPick = {
  pickId: string;
  capperId: string;
  capperName: string;
  capperColorTag: string | null;
  homeTeam: string;
  awayTeam: string;
  betDetail: string | null;
  betType: string;
  odds: number;
  units: number;
  gameTime: Date;
  record: { wins: number; losses: number; pushes: number; winPct: number };
};

export type SharpMoneyCategorySection = {
  key: PickCategoryKey;
  label: string;
  picks: SharpMoneyPick[]; // sorted winPct desc
};

export type SharpMoneySportSection = {
  sportName: string;
  categories: SharpMoneyCategorySection[]; // only categories with >=1 qualifying pick
};

export type SharpMoneyBoard =
  | { status: "no_picks" } // nothing posted today at all yet
  | { status: "cleared" } // today's picks exist but every one has already graded - day's action is over
  | { status: "active"; sports: SharpMoneySportSection[] }; // sports may be [] if nothing qualifies yet

// Sort order for sport sections - matches the Live page's own tab order for
// the sports this app actively tracks; anything else (an ad-hoc sport from a
// catalog import, e.g. NCAAF) sorts alphabetically after those.
function sportSortIndex(sportName: string): number {
  const idx = LIVE_SPORTS.findIndex((s) => s.label.toUpperCase() === sportName.toUpperCase());
  return idx === -1 ? LIVE_SPORTS.length : idx;
}

// Display order for category sections within a sport - every key pickCategory
// can actually produce. First-half spread/total and touchdown props aren't
// listed here because pickCategory itself returns null for them (genuinely
// untracked - see stats.ts), so they never reach this function at all.
const CATEGORY_ORDER: PickCategoryKey[] = [
  "FAV_ML",
  "DOG_ML",
  "SPREAD_MINUS",
  "SPREAD_PLUS",
  "OVER",
  "UNDER",
  "F5_ML",
  "FIRST_HALF_ML",
  "NRFI",
];

// Today's picks where the capper has a historically strong (>=55% win rate)
// record in that exact bet category - not their overall record. "Today" and
// "cleared" both key off gameTime's Eastern calendar day and each pick's own
// status, not a fixed midnight cutoff - see the early-return checks below.
export async function getSharpMoneyBoard(userId: string): Promise<SharpMoneyBoard> {
  const now = new Date();
  const todayStart = startOfEasternDay(now);
  const tomorrowStart = startOfEasternDay(new Date(now.getTime() + 86400000));

  const todaysPicks = await prisma.pick.findMany({
    where: { userId, gameTime: { gte: todayStart, lt: tomorrowStart } },
    include: { capper: true, sport: true },
    orderBy: { gameTime: "asc" },
  });

  if (todaysPicks.length === 0) return { status: "no_picks" };
  // A pick only ever leaves PENDING once its game has actually graded - once
  // every one of today's picks has, today's slate is genuinely over, however
  // many hours before midnight that happens to be.
  if (todaysPicks.every((p) => p.status !== "PENDING")) return { status: "cleared" };

  const categorized = todaysPicks
    .map((p) => ({ pick: p, category: pickCategory({ ...p, sportName: p.sport.name }) }))
    .filter((e): e is { pick: (typeof todaysPicks)[number]; category: PickCategoryKey } => e.category !== null);

  // One category-record lookup per distinct (capperId, category) pair, not
  // per pick - several of today's picks can share the same capper+category.
  const uniquePairs = Array.from(
    new Map(
      categorized.map((e) => [e.pick.capperId + "|" + e.category, { capperId: e.pick.capperId, category: e.category }])
    ).values()
  );
  const records = new Map(
    await Promise.all(
      uniquePairs.map(async (pair) => {
        const record = await getCapperCategoryRecord(userId, pair.capperId, pair.category);
        return [pair.capperId + "|" + pair.category, record] as const;
      })
    )
  );

  const bySport = new Map<string, Map<PickCategoryKey, SharpMoneyPick[]>>();
  for (const { pick, category } of categorized) {
    const record = records.get(pick.capperId + "|" + category);
    if (!record || record.winPct < QUALIFYING_WIN_PCT) continue;

    const sportName = pick.sport.name;
    if (!bySport.has(sportName)) bySport.set(sportName, new Map());
    const byCategory = bySport.get(sportName)!;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push({
      pickId: pick.id,
      capperId: pick.capperId,
      capperName: pick.capper.name,
      capperColorTag: pick.capper.colorTag,
      homeTeam: pick.homeTeam,
      awayTeam: pick.awayTeam,
      betDetail: pick.betDetail,
      betType: pick.betType,
      odds: pick.odds,
      units: pick.units,
      gameTime: pick.gameTime,
      record: { wins: record.wins, losses: record.losses, pushes: record.pushes, winPct: record.winPct },
    });
  }

  const sports: SharpMoneySportSection[] = Array.from(bySport.entries())
    .map(([sportName, byCategory]) => {
      const categories: SharpMoneyCategorySection[] = CATEGORY_ORDER.filter((key) => byCategory.has(key)).map(
        (key) => ({
          key,
          label: PICK_CATEGORY_LABELS[key],
          picks: byCategory.get(key)!.sort((a, b) => b.record.winPct - a.record.winPct),
        })
      );
      return { sportName, categories };
    })
    .filter((s) => s.categories.length > 0)
    .sort((a, b) => sportSortIndex(a.sportName) - sportSortIndex(b.sportName));

  return { status: "active", sports };
}
