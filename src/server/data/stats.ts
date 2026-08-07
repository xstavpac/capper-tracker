import { prisma } from "@/lib/prisma";
import type { Pick, PickStatus } from "@prisma/client";
import { favoriteOrUnderdog } from "@/lib/bet-line";

export type OverallStats = {
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
  unitsWon: number;
  unitsLost: number;
  netUnits: number;
  roi: number;
  currentStreak: { type: "WIN" | "LOSS" | "NONE"; count: number };
  longestWinStreak: number;
  longestLossStreak: number;
};

/**
 * Converts American odds + units risked into units returned on a win.
 * Positive odds (+150): profit = units * (odds / 100)
 * Negative odds (-110): profit = units * (100 / abs(odds))
 */
export function unitsWonOnBet(units: number, odds: number): number {
  if (odds > 0) return units * (odds / 100);
  return units * (100 / Math.abs(odds));
}

/**
 * Computes overall record, ROI, units, and streaks for a set of picks.
 * This is called with all of a user's picks (dashboard) or a single
 * capper's picks (capper page) — same math, different scope.
 */
export function computeStats(picks: Pick[]): OverallStats {
  // Streaks depend on chronological order, so sort oldest -> newest first.
  const sorted = [...picks].sort(
    (a, b) => a.gameTime.getTime() - b.gameTime.getTime()
  );

  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let unitsWon = 0;
  let unitsLost = 0;
  let unitsRisked = 0;

  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let runningWin = 0;
  let runningLoss = 0;

  for (const pick of sorted) {
    if (pick.status === "PENDING" || pick.status === "CANCELLED") continue;

    unitsRisked += pick.units;

    if (pick.status === "WIN") {
      wins++;
      unitsWon += unitsWonOnBet(pick.units, pick.odds);
      runningWin++;
      runningLoss = 0;
      longestWinStreak = Math.max(longestWinStreak, runningWin);
    } else if (pick.status === "LOSS") {
      losses++;
      unitsLost += pick.units;
      runningLoss++;
      runningWin = 0;
      longestLossStreak = Math.max(longestLossStreak, runningLoss);
    } else if (pick.status === "PUSH") {
      pushes++;
      runningWin = 0;
      runningLoss = 0;
    }
  }

  const decided = wins + losses;
  const netUnits = unitsWon - unitsLost;

  return {
    wins,
    losses,
    pushes,
    winPct: decided > 0 ? (wins / decided) * 100 : 0,
    unitsWon: round2(unitsWon),
    unitsLost: round2(unitsLost),
    netUnits: round2(netUnits),
    roi: unitsRisked > 0 ? round2((netUnits / unitsRisked) * 100) : 0,
    currentStreak: currentStreak(sorted),
    longestWinStreak,
    longestLossStreak,
  };
}

function currentStreak(
  sortedOldestFirst: Pick[]
): { type: "WIN" | "LOSS" | "NONE"; count: number } {
  const decided = sortedOldestFirst.filter(
    (p) => p.status === "WIN" || p.status === "LOSS"
  );
  if (decided.length === 0) return { type: "NONE", count: 0 };

  const last = decided[decided.length - 1];
  const type = last.status as "WIN" | "LOSS";
  let count = 0;

  for (let i = decided.length - 1; i >= 0; i--) {
    if (decided[i].status === type) count++;
    else break;
  }

  return { type, count };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// Minimum decided (win+loss+push) picks before a capper gets a numbered rank
// on the main Cappers leaderboard - confirmed with the user alongside the
// weighted-ranking approach below. Below this, a capper's raw ROI is too
// noisy to rank on (a 1-0 capper "looks" better than a 40-10 one by ROI
// alone) - they're deliberately left off the main ranking and surfaced
// instead by the "Rising" panel, which is built for exactly this case.
export const RANKING_MIN_SAMPLE = 5;

// Shrinkage strength in "pseudo-picks", pulling a capper's weighted score
// toward a 0% (breakeven) prior until real volume outweighs it - a capper
// with only RANKING_MIN_SAMPLE picks has just 5/(5+10) = 1/3 of their raw
// ROI reflected in the score, while one with 50 picks has 50/60 = 5/6.
// Chosen (not derived) as a "modest" prior per the user's confirmed
// ROI-based Bayesian shrinkage approach - tune here if rankings feel too
// flat (raise) or too swingy on small samples (lower... within reason,
// samples below RANKING_MIN_SAMPLE never reach this function at all).
const RANKING_SHRINKAGE_K = 10;

// Confidence-weighted ranking score - the main leaderboard's default sort,
// so a small hot streak can't outrank a large real sample. The raw record/
// ROI is still shown alongside this for transparency; this only changes
// sort order, never displayed numbers.
export function weightedRoiScore(stats: OverallStats): number {
  const n = stats.wins + stats.losses + stats.pushes;
  if (n === 0) return 0;
  return round2((stats.roi * n) / (n + RANKING_SHRINKAGE_K));
}

// A capper's record broken down by bet category, so "good overall" and "good
// at the specific bet they just gave you" can be told apart at a glance.
export type ScorecardBucketKey = "MONEYLINE" | "SPREAD" | "TOTAL" | "PLAYER_PROP" | "F5" | "NRFI";
export type ScorecardBucket = {
  key: ScorecardBucketKey;
  label: string;
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
  count: number; // decided picks: wins + losses + pushes
  tone: "positive" | "negative" | "neutral";
};

export const SCORECARD_MIN_SAMPLE = 5;
export const SCORECARD_WIN_THRESHOLD = 52.4; // -110 breakeven: 110 / 210

const SCORECARD_BUCKET_ORDER: ScorecardBucketKey[] = [
  "MONEYLINE",
  "SPREAD",
  "TOTAL",
  "PLAYER_PROP",
  "F5",
  "NRFI",
];
const SCORECARD_BUCKET_LABELS: Record<ScorecardBucketKey, string> = {
  MONEYLINE: "Moneyline",
  SPREAD: "Spread",
  TOTAL: "Total",
  PLAYER_PROP: "Player Prop",
  F5: "F5",
  NRFI: "NRFI",
};

// F5 (first half) picks form their own bucket regardless of bet type - a
// first-half spread pick is grouped with other F5 picks, not the full-game
// spread record, since it's graded against a different score entirely.
function bucketKeyForPick(pick: Pick): ScorecardBucketKey {
  return pick.period === "FIRST_HALF" ? "F5" : (pick.betType as ScorecardBucketKey);
}

function scorecardTone(winPct: number, count: number): ScorecardBucket["tone"] {
  if (count < SCORECARD_MIN_SAMPLE) return "neutral";
  return winPct >= SCORECARD_WIN_THRESHOLD ? "positive" : "negative";
}

export function computeScorecard(picks: Pick[]): ScorecardBucket[] {
  const byBucket = new Map<ScorecardBucketKey, Pick[]>();
  for (const pick of picks) {
    const key = bucketKeyForPick(pick);
    const existing = byBucket.get(key);
    if (existing) existing.push(pick);
    else byBucket.set(key, [pick]);
  }

  return SCORECARD_BUCKET_ORDER.filter((key) => byBucket.has(key)).map((key) => {
    const stats = computeStats(byBucket.get(key)!);
    const count = stats.wins + stats.losses + stats.pushes;
    return {
      key,
      label: SCORECARD_BUCKET_LABELS[key],
      wins: stats.wins,
      losses: stats.losses,
      pushes: stats.pushes,
      winPct: stats.winPct,
      count,
      tone: scorecardTone(stats.winPct, count),
    };
  });
}

// A finer split than ScorecardBucketKey, built for the Cappers-page
// league/bet-type filter chips - e.g. "Fav ML" and "Dog ML" are both
// MONEYLINE picks but represent opposite sides, so they can't share a
// bucket the way the scorecard (which only cares about bet type + F5) does.
export type PickCategoryKey = "FAV_ML" | "DOG_ML" | "SPREAD" | "OVER" | "UNDER" | "F5_ML" | "NRFI";

export const PICK_CATEGORY_LABELS: Record<PickCategoryKey, string> = {
  FAV_ML: "Fav ML",
  DOG_ML: "Dog ML",
  SPREAD: "Spread",
  OVER: "Over",
  UNDER: "Under",
  F5_ML: "F5 ML",
  NRFI: "NRFI",
};

// F5 and NRFI are MLB-only chips for now, even though Period/BetType could
// technically represent a first-half bet in another sport - other leagues
// intentionally don't surface those two categories yet.
const MLB_CHIP_SET: PickCategoryKey[] = ["FAV_ML", "DOG_ML", "SPREAD", "OVER", "UNDER", "F5_ML", "NRFI"];
const DEFAULT_CHIP_SET: PickCategoryKey[] = ["FAV_ML", "DOG_ML", "SPREAD", "OVER", "UNDER"];

export function chipSetForLeague(sportName: string): PickCategoryKey[] {
  return sportName.toUpperCase() === "MLB" ? MLB_CHIP_SET : DEFAULT_CHIP_SET;
}

type PickCategoryInput = {
  betType: Pick["betType"];
  period: Pick["period"];
  betDetail: string | null;
  odds: number;
  line: number | null;
};

export function pickCategory(pick: PickCategoryInput): PickCategoryKey | null {
  if (pick.betType === "NRFI") return "NRFI";

  if (pick.betType === "MONEYLINE") {
    if (pick.period === "FIRST_HALF") return "F5_ML";
    const side = favoriteOrUnderdog(pick);
    return side === "FAVORITE" ? "FAV_ML" : side === "UNDERDOG" ? "DOG_ML" : null;
  }

  if (pick.betType === "SPREAD" && pick.period === "FULL_GAME") return "SPREAD";

  if (pick.betType === "TOTAL" && pick.period === "FULL_GAME") {
    const detail = (pick.betDetail ?? "").toLowerCase();
    if (detail.includes("over")) return "OVER";
    if (detail.includes("under")) return "UNDER";
    return null;
  }

  return null;
}

/** All picks for a user, scoped by userId — never call prisma.pick directly. */
export async function getUserPicks(userId: string) {
  return prisma.pick.findMany({
    where: { userId },
    include: { capper: true, sport: true, league: true },
    orderBy: { gameTime: "desc" },
  });
}

/** Dashboard summary: overall stats + top/worst performing capper. */
export async function getDashboardSummary(userId: string) {
  const picks = await getUserPicks(userId);
  const overall = computeStats(picks);

  const byCapperMap = new Map<string, Pick[]>();
  for (const pick of picks) {
    const list = byCapperMap.get(pick.capperId) ?? [];
    list.push(pick);
    byCapperMap.set(pick.capperId, list);
  }

  const capperStats = Array.from(byCapperMap.entries()).map(
    ([capperId, capperPicks]) => ({
      capperId,
      stats: computeStats(capperPicks),
    })
  );

  const bySortedRoi = [...capperStats].sort((a, b) => b.stats.roi - a.stats.roi);

  return {
    overall,
    pendingCount: picks.filter((p) => p.status === "PENDING").length,
    topCapper: bySortedRoi[0] ?? null,
    worstCapper: bySortedRoi[bySortedRoi.length - 1] ?? null,
    recentPicks: picks.slice(0, 10),
  };
}

export type ReportBreakdownItem = { name: string; stats: OverallStats; count: number };

export async function getReportsData(userId: string) {
  const picks = await getUserPicksWithRelations(userId);
  const overall = computeStats(picks);

  function groupBy<T extends { id: string; name: string }>(
    getGroupKey: (pick: (typeof picks)[number]) => T | null
  ): ReportBreakdownItem[] {
    const map = new Map<string, { name: string; picks: typeof picks }>();
    for (const pick of picks) {
      const group = getGroupKey(pick);
      if (!group) continue;
      const existing = map.get(group.id);
      if (existing) {
        existing.picks.push(pick);
      } else {
        map.set(group.id, { name: group.name, picks: [pick] });
      }
    }
    return Array.from(map.values())
      .map((g) => ({ name: g.name, stats: computeStats(g.picks), count: g.picks.length }))
      .sort((a, b) => b.stats.roi - a.stats.roi);
  }

  const byCapper = groupBy((p) => ({ id: p.capperId, name: p.capper.name }));
  const bySport = groupBy((p) => ({ id: p.sportId, name: p.sport.name }));
  const byLeague = groupBy((p) => (p.league ? { id: p.league.id, name: p.league.name } : null));
  const byBetType = groupBy((p) => ({ id: p.betType, name: betTypeLabel(p.betType) }));
  const byPeriod = groupBy((p) => ({
    id: p.period,
    name: p.period === "FIRST_HALF" ? "First half / F5" : "Full game",
  }));
  const byFavoriteDog = groupBy((p) => {
    const side = favoriteOrUnderdog(p);
    return side ? { id: side, name: side === "FAVORITE" ? "Favorite" : "Underdog" } : null;
  });

  return {
    overall,
    byCapper,
    bySport,
    byLeague,
    byBetType,
    byPeriod,
    byFavoriteDog,
    bestCapper: byCapper[0] ?? null,
    worstCapper: byCapper[byCapper.length - 1] ?? null,
    bestSport: bySport[0] ?? null,
    worstSport: bySport[bySport.length - 1] ?? null,
    bestBetType: byBetType[0] ?? null,
  };
}

export function betTypeLabel(betType: string) {
  switch (betType) {
    case "SPREAD":
      return "Spread";
    case "MONEYLINE":
      return "Moneyline";
    case "TOTAL":
      return "Total";
    case "PLAYER_PROP":
      return "Player Prop";
    default:
      return betType;
  }
}

async function getUserPicksWithRelations(userId: string) {
  return prisma.pick.findMany({
    where: { userId },
    include: { capper: true, sport: true, league: true },
  });
}

export type UnitsChartPoint = { date: string; cumulativeUnits: number };

export function computeUnitsChartData(picks: Pick[]): UnitsChartPoint[] {
  const settled = [...picks]
    .filter((p) => p.status === "WIN" || p.status === "LOSS" || p.status === "PUSH")
    .sort((a, b) => a.gameTime.getTime() - b.gameTime.getTime());

  let running = 0;
  return settled.map((pick) => {
    if (pick.status === "WIN") {
      running += unitsWonOnBet(pick.units, pick.odds);
    } else if (pick.status === "LOSS") {
      running -= pick.units;
    }
    return {
      date: pick.gameTime.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      cumulativeUnits: Math.round(running * 100) / 100,
    };
  });
}
