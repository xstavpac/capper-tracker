import { SAMPLE_SIZE_FLOOR, SKEW_FLOOR_HIGH, SKEW_FLOOR_LOW, type GamePulsePanelRow } from "@/server/data/game-pulse";
import type { SituationalRate } from "@/server/data/game-pulse-situations";
import {
  NFL_SITUATIONAL_QUESTIONS,
  getNflTeamSituationalRates,
  type NflSituationalQuestionKey,
  type NflSituationalRatesByQuestion,
} from "@/server/data/nfl-game-pulse-situations";

const ROW_TITLES: Record<NflSituationalQuestionKey, string> = {
  scoredFirst: "Scored first",
  leadingAtHalftime: "Leading at halftime",
  wonTurnoverBattle: "Won the turnover battle",
  ledByDoubleDigits: "Led by double digits",
  trailingEntering4th: "Trailing entering the 4th",
};

function clearsFloor(rate: SituationalRate): boolean {
  return rate.total >= SAMPLE_SIZE_FLOOR && (rate.winPct >= SKEW_FLOOR_HIGH || rate.winPct <= SKEW_FLOOR_LOW);
}

// Same row-eligibility/highlight algorithm as MLB's buildGamePulsePanelRows
// (game-pulse.ts) - not imported from there since that function is typed to
// MLB's own rates-by-question shape, but deliberately kept byte-for-byte
// equivalent in logic, same "one function per sport rather than a generic
// dispatcher" precedent already used throughout this codebase's ESPN
// fetchers. SAMPLE_SIZE_FLOOR/SKEW_FLOOR_HIGH/SKEW_FLOOR_LOW themselves ARE
// imported (not redefined) - the actual threshold values, not just the
// shape of the logic, are the single source of truth worth sharing.
export function buildNflGamePulsePanelRows(
  homeRates: NflSituationalRatesByQuestion,
  awayRates: NflSituationalRatesByQuestion
): GamePulsePanelRow[] {
  return NFL_SITUATIONAL_QUESTIONS.map((question) => {
    const home = homeRates[question.key];
    const away = awayRates[question.key];
    const homeEligible = clearsFloor(home);
    const awayEligible = clearsFloor(away);
    const showData = homeEligible || awayEligible;

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

// Same module-scope caching rationale as MLB's getCachedTeamRates
// (game-pulse.ts) - per-team rates barely change between page loads.
const RATE_CACHE_TTL_MS = 60 * 60 * 1000;
const rateCache = new Map<string, { value: NflSituationalRatesByQuestion; expiresAt: number }>();

async function getCachedNflTeamRates(team: string): Promise<NflSituationalRatesByQuestion> {
  const cached = rateCache.get(team);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await getNflTeamSituationalRates(team);
  rateCache.set(team, { value, expiresAt: Date.now() + RATE_CACHE_TTL_MS });
  return value;
}

// The NFL game detail page's data entry point - mirrors MLB's
// getGamePulsePanelRows exactly (game-pulse.ts), reusing the same
// GamePulsePanel UI component since GamePulsePanelRow's shape is
// sport-agnostic.
export async function getNflGamePulsePanelRows(homeTeam: string, awayTeam: string): Promise<GamePulsePanelRow[]> {
  const [homeRates, awayRates] = await Promise.all([getCachedNflTeamRates(homeTeam), getCachedNflTeamRates(awayTeam)]);
  return buildNflGamePulsePanelRows(homeRates, awayRates);
}
