import {
  SITUATIONAL_QUESTIONS,
  getTeamSituationalRates,
  BIG_INNING_RUN_THRESHOLD,
  type SituationalQuestionKey,
  type SituationalRate,
  type SituationalRatesByQuestion,
} from "@/server/data/game-pulse-situations";

// Thresholds signed off on 2026-08-19 - see the investigation writeup this
// feature came out of. Not tunable via env/config for v1; change here and
// redeploy if they need revisiting. Exported so the panel-row builder below
// (and its acceptance test) share the exact same floor as the rest of Game
// Pulse - this is the "confidence floor" the game detail panel gates each
// row's display on.
export const SAMPLE_SIZE_FLOOR = 10; // a team+situation needs this many historical GameResult rows before its rate counts at all
export const SKEW_FLOOR_HIGH = 58; // win% at/above this counts as a meaningfully strong rate
export const SKEW_FLOOR_LOW = 42; // win% at/below this counts as a meaningfully weak rate (also "clears the floor" - just in the other direction)

const ROW_TITLES: Record<SituationalQuestionKey, string> = {
  scoredFirst: "Scored first",
  leadingAfter5: "Leading after 5",
  leadingAfter7: "Leading after 7",
  bigInning: "Big inning (" + BIG_INNING_RUN_THRESHOLD + "+ runs)",
  trailingAfter7: "Trailing after 7",
};

export type GamePulsePanelRow = {
  key: SituationalQuestionKey;
  title: string;
  home: SituationalRate;
  away: SituationalRate;
  // Whether each team's OWN rate individually clears the confidence floor
  // (sample size + skew) - used to decide who gets highlighted, not whether
  // the row shows data at all (see showData below).
  homeEligible: boolean;
  awayEligible: boolean;
  // A row shows real numbers once at least one team's rate clears the
  // floor - the whole point of a floor is to keep a near-coin-flip or
  // tiny-sample rate from being displayed as if it meant something, but
  // once ONE side has a real signal the comparison itself is still
  // meaningful even if the other side's rate is unremarkable. Only when
  // NEITHER team clears it is there nothing real to show.
  showData: boolean;
  // Whichever team's rate deviates further from 50% - the "notably higher/
  // more skewed" side the row should visually emphasize. Null when there's
  // no data to show, or (rare) both sides deviate identically.
  highlightSide: "home" | "away" | null;
};

function clearsFloor(rate: SituationalRate): boolean {
  return rate.total >= SAMPLE_SIZE_FLOOR && (rate.winPct >= SKEW_FLOOR_HIGH || rate.winPct <= SKEW_FLOOR_LOW);
}

// Pure tally-free row builder - no I/O, so this is the part real-data
// verification and the acceptance test actually exercise directly. Always
// returns exactly 5 rows (one per SITUATIONAL_QUESTIONS entry, in that
// fixed order) regardless of data availability - the detail page never
// hides a row, it shows "Not enough data yet" via showData instead.
export function buildGamePulsePanelRows(
  homeRates: SituationalRatesByQuestion,
  awayRates: SituationalRatesByQuestion
): GamePulsePanelRow[] {
  return SITUATIONAL_QUESTIONS.map((question) => {
    const home = homeRates[question.key];
    const away = awayRates[question.key];
    const homeEligible = clearsFloor(home);
    const awayEligible = clearsFloor(away);
    const showData = homeEligible || awayEligible;

    // Only compare raw deviation-from-50 between two teams that are BOTH
    // individually eligible - an ineligible team's winPct is often a
    // meaningless artifact (0% for a team with zero qualifying games, e.g.)
    // that can look more "extreme" than a real, floor-clearing rate on the
    // other side. When only one side clears the floor, that side is the
    // highlight by definition - there's nothing statistically real to
    // compare it against.
    let highlightSide: "home" | "away" | null = null;
    if (homeEligible && !awayEligible) highlightSide = "home";
    else if (awayEligible && !homeEligible) highlightSide = "away";
    else if (homeEligible && awayEligible) {
      const homeDeviation = Math.abs(home.winPct - 50);
      const awayDeviation = Math.abs(away.winPct - 50);
      if (homeDeviation > awayDeviation) highlightSide = "home";
      else if (awayDeviation > homeDeviation) highlightSide = "away";
    }

    return {
      key: question.key,
      title: ROW_TITLES[question.key],
      home,
      away,
      homeEligible,
      awayEligible,
      showData,
      highlightSide,
    };
  });
}

// Per-team situational rates barely change from one page load to the next
// (they only move when persistFinalScores grades a new game), so re-querying
// GameResult on every /live/[gameId] visit for the same two teams is pure
// waste. Cached in module scope, same "survives warm serverless invocations,
// reset on a cold one" reasoning lib/prisma.ts already relies on for its
// singleton client - a cold-start cache miss just recomputes, it's a cost
// optimization, not a correctness dependency.
const RATE_CACHE_TTL_MS = 60 * 60 * 1000;
const rateCache = new Map<string, { value: SituationalRatesByQuestion; expiresAt: number }>();

async function getCachedTeamRates(team: string): Promise<SituationalRatesByQuestion> {
  const cached = rateCache.get(team);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await getTeamSituationalRates(team);
  rateCache.set(team, { value, expiresAt: Date.now() + RATE_CACHE_TTL_MS });
  return value;
}

// The game detail page's data entry point - fetches both teams' historical
// situational rates (cached, see above) and builds the fixed 5-row panel.
// MLB-only in practice, same as the rest of Game Pulse: getTeamSituationalRates
// only ever returns non-zero rates for baseball_mlb rows, so every other
// sport's rows come back all showData: false ("Not enough data yet"
// everywhere), which is the correct behavior rather than a special case.
export async function getGamePulsePanelRows(homeTeam: string, awayTeam: string): Promise<GamePulsePanelRow[]> {
  const [homeRates, awayRates] = await Promise.all([getCachedTeamRates(homeTeam), getCachedTeamRates(awayTeam)]);
  return buildGamePulsePanelRows(homeRates, awayRates);
}
