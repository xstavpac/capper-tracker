// The MLB Momentum calculation engine - pure functions only, no I/O. Fed
// pre-fetched inputs (live plays, point-in-time historical lines) by
// mlb-momentum-data.ts, which owns every prisma/fetch call. Same split as
// game-pulse.ts's buildGamePulsePanelRows (pure builder) vs
// getGamePulsePanelRows (I/O) - the pure half is what an acceptance test can
// exercise directly, with no DB required.
//
// Core guardrail (whitepaper Section 6): Momentum is a RATE-OF-CHANGE signal,
// never an absolute win-probability read. computeMomentumTrend below is the
// only function that produces the gauge's classification, and it looks at
// how win probability MOVED over a recent window of plays - never at its
// current absolute level. currentHomeWinProbability is carried on the result
// for display context only; nothing here classifies off it.

export type MomentumClassification = "STRONG_HOME" | "LEAN_HOME" | "EVEN" | "LEAN_AWAY" | "STRONG_AWAY";

// ---------------------------------------------------------------------------
// Tentative thresholds - a reasonable placeholder, not a calibrated one.
// Real calibration (whitepaper Phase 6) needs a backtest against a season of
// real win-probability series, which doesn't exist yet. Exported so the
// acceptance test and any future calibration pass share these constants
// instead of hardcoding copies.
// ---------------------------------------------------------------------------

// How many of the most recent plays the rate-of-change window covers. ~12
// plate appearances is roughly 1.5-2 innings - long enough to smooth over a
// single play's noise, short enough to stay "recent" rather than
// whole-game.
export const MOMENTUM_WINDOW_PLAYS = 12;
// Fewer than this many deltas in the window (i.e. very early in the game)
// and the read isn't trusted yet - early-game protection per whitepaper
// Section 24, so four batters in the 1st doesn't swing the gauge.
export const MOMENTUM_MIN_DELTAS_FOR_READ = 5;
// Cumulative home-win-probability-point shift within the window.
export const MOMENTUM_STRONG_THRESHOLD = 15;
export const MOMENTUM_LEAN_THRESHOLD = 6;

export type MomentumTrend = {
  classification: MomentumClassification;
  // Signed sum of consecutive homeWinProbability deltas across the window -
  // positive means win probability moved toward the home team over that
  // stretch, negative toward the away team. This, not any absolute
  // probability, is what classification is computed from.
  netShift: number;
  // Number of deltas the window actually had (entries considered - 1, floored
  // at 0) - distinct from MOMENTUM_WINDOW_PLAYS, which is the window's cap,
  // not how much game has actually happened yet.
  deltasConsidered: number;
  // Context for the UI only (e.g. "Cubs 63%") - never an input to
  // classification. Null before the game's first play exists.
  currentHomeWinProbability: number | null;
};

export function computeMomentumTrend(plays: { homeWinProbability: number }[]): MomentumTrend {
  if (plays.length === 0) {
    return { classification: "EVEN", netShift: 0, deltasConsidered: 0, currentHomeWinProbability: null };
  }

  const window = plays.slice(-MOMENTUM_WINDOW_PLAYS);
  let netShift = 0;
  for (let i = 1; i < window.length; i++) {
    netShift += window[i].homeWinProbability - window[i - 1].homeWinProbability;
  }
  const deltasConsidered = Math.max(0, window.length - 1);
  const currentHomeWinProbability = plays[plays.length - 1].homeWinProbability;

  if (deltasConsidered < MOMENTUM_MIN_DELTAS_FOR_READ) {
    return { classification: "EVEN", netShift, deltasConsidered, currentHomeWinProbability };
  }

  let classification: MomentumClassification;
  if (netShift >= MOMENTUM_STRONG_THRESHOLD) classification = "STRONG_HOME";
  else if (netShift >= MOMENTUM_LEAN_THRESHOLD) classification = "LEAN_HOME";
  else if (netShift <= -MOMENTUM_STRONG_THRESHOLD) classification = "STRONG_AWAY";
  else if (netShift <= -MOMENTUM_LEAN_THRESHOLD) classification = "LEAN_AWAY";
  else classification = "EVEN";

  return { classification, netShift, deltasConsidered, currentHomeWinProbability };
}

// ---------------------------------------------------------------------------
// Factors - each pure, each independently testable, each degrading to
// "unavailable" (never a fabricated lean) when its input data doesn't exist
// yet. Order here is display order.
// ---------------------------------------------------------------------------

export type MomentumFactorLean = "home" | "away" | "even" | "unavailable";
export type MomentumFactor = { key: string; label: string; lean: MomentumFactorLean; detail: string };

function leanFromCompare(home: number, away: number): MomentumFactorLean {
  return home === away ? "even" : home > away ? "home" : "away";
}

// --- Recent team form: last-10 win% + current streak. Reuses the existing
// point-in-time team_stats resolver (resolveVariable, model-engine/resolver.ts)
// rather than re-querying TeamStatSnapshot directly - the same reuse the rest
// of this codebase follows (never a second implementation of an existing
// point-in-time read).
export type TeamFormInput = { teamName: string; last10WinPct: number | null; streak: number | null };

function streakLabel(streak: number | null): string {
  if (streak === null || streak === 0) return "";
  return streak > 0 ? ` (W${streak})` : ` (L${Math.abs(streak)})`;
}

export function recentFormFactor(home: TeamFormInput, away: TeamFormInput): MomentumFactor {
  if (home.last10WinPct === null && away.last10WinPct === null) {
    return { key: "recentForm", label: "Recent team form", lean: "unavailable", detail: "No recent-form data yet this season." };
  }
  const h = home.last10WinPct ?? 0.5;
  const a = away.last10WinPct ?? 0.5;
  const pct = (v: number | null) => (v === null ? "?" : Math.round(v * 100) + "%");
  return {
    key: "recentForm",
    label: "Recent team form",
    lean: leanFromCompare(h, a),
    detail: `${home.teamName} ${pct(home.last10WinPct)} L10${streakLabel(home.streak)} · ${away.teamName} ${pct(away.last10WinPct)} L10${streakLabel(away.streak)}`,
  };
}

// --- Recent scoring: avg runs scored over each team's last few finished
// games (point-in-time - the caller must only pass games strictly before
// today's Eastern day). Nothing existing computes a rolling recent-runs
// figure (TeamStatSnapshot only has season-cumulative run differential), so
// this is genuinely new, not a parallel copy of something that exists.
export type RecentScoringInput = { teamName: string; avgRunsLastN: number | null; gamesConsidered: number };

export function recentScoringFactor(home: RecentScoringInput, away: RecentScoringInput): MomentumFactor {
  if (home.avgRunsLastN === null && away.avgRunsLastN === null) {
    return { key: "recentScoring", label: "Recent scoring", lean: "unavailable", detail: "No finished games yet this season." };
  }
  const h = home.avgRunsLastN ?? 0;
  const a = away.avgRunsLastN ?? 0;
  const fmt = (v: number | null) => (v === null ? "?" : v.toFixed(1));
  return {
    key: "recentScoring",
    label: "Recent scoring",
    lean: leanFromCompare(h, a),
    detail: `${home.teamName} ${fmt(home.avgRunsLastN)} runs/gm (L${home.gamesConsidered}) · ${away.teamName} ${fmt(away.avgRunsLastN)} runs/gm (L${away.gamesConsidered})`,
  };
}

// --- In-game scoring: runs each side has plated within the same
// rate-of-change window Momentum itself uses (not the whole game) - keeps
// this factor answering "who's scoring RIGHT NOW", consistent with the
// gauge's own rate-of-change framing rather than a season-style total.
export function inGameScoringFactor(
  homeTeam: string,
  awayTeam: string,
  windowPlays: { homeScore: number; awayScore: number }[]
): MomentumFactor {
  if (windowPlays.length < 2) {
    return { key: "inGameScoring", label: "In-game scoring", lean: "unavailable", detail: "Not enough plays yet this game." };
  }
  const first = windowPlays[0];
  const last = windowPlays[windowPlays.length - 1];
  const homeRuns = last.homeScore - first.homeScore;
  const awayRuns = last.awayScore - first.awayScore;
  return {
    key: "inGameScoring",
    label: "In-game scoring",
    lean: leanFromCompare(homeRuns, awayRuns),
    detail: `${homeTeam} +${homeRuns} · ${awayTeam} +${awayRuns} over the last ${windowPlays.length} plays`,
  };
}

// --- Base/out situation: the CURRENT threat level, from the most recent
// play's own base-out state. Leans toward whichever team is at bat only when
// they hold real scoring position (a runner on 2nd or 3rd) with fewer than 2
// outs - anything else is "even", not a fabricated lean toward whoever
// happens to be hitting.
export type LatestPlayState = { isTopInning: boolean; outs: number; runnersOnBase: string[]; inning: number };

export function baseOutFactor(homeTeam: string, awayTeam: string, latest: LatestPlayState | null): MomentumFactor {
  if (!latest) {
    return { key: "baseOut", label: "Base/out situation", lean: "unavailable", detail: "Game hasn't started yet." };
  }
  const battingTeam = latest.isTopInning ? awayTeam : homeTeam;
  const risp = latest.runnersOnBase.includes("2B") || latest.runnersOnBase.includes("3B");
  const isThreat = risp && latest.outs < 2;
  const lean: MomentumFactorLean = isThreat ? (latest.isTopInning ? "away" : "home") : "even";
  const baseText = latest.runnersOnBase.length === 0 ? "bases empty" : latest.runnersOnBase.join("/") + " occupied";
  return {
    key: "baseOut",
    label: "Base/out situation",
    lean,
    detail: `${battingTeam} batting, ${latest.outs} out, ${baseText} (inning ${latest.inning})`,
  };
}

// --- Starting pitcher performance: point-in-time ERA comparison, reusing
// getHistoricalStartingMatchup (mlb-pitcher-history.ts) exactly as-is - it
// already resolves each side's actual-or-probable starter and their
// day-before-the-game season line, which is precisely what this factor
// needs and nothing this codebase doesn't already compute.
export type PitcherLineInput = { pitcherName: string; era: number | null } | null;

export function startingPitcherFactor(
  homeTeam: string,
  awayTeam: string,
  home: PitcherLineInput,
  away: PitcherLineInput
): MomentumFactor {
  if (!home && !away) {
    return { key: "startingPitcher", label: "Starting pitcher performance", lean: "unavailable", detail: "Starters not announced yet." };
  }
  const h = home?.era ?? null;
  const a = away?.era ?? null;
  const lean: MomentumFactorLean = h === null || a === null ? "unavailable" : h === a ? "even" : h < a ? "home" : "away";
  const fmt = (l: PitcherLineInput) => (l ? `${l.pitcherName}${l.era !== null ? " " + l.era.toFixed(2) + " ERA" : ""}` : "TBD");
  return {
    key: "startingPitcher",
    label: "Starting pitcher performance",
    lean,
    detail: `${homeTeam}: ${fmt(home)} · ${awayTeam}: ${fmt(away)}`,
  };
}

// --- Bullpen usage: whether each side has already gone to its bullpen,
// derived from comparing the game's starter (getHistoricalStartingMatchup)
// against the pitcher currently credited on the live feed's most recent play
// for that side (currentPitcherForTeam below). Deliberately informational
// only (lean stays "even") - which side has needed its bullpen first isn't,
// by itself, a directional signal the way the other factors are; it's
// exactly the kind of thing the whitepaper warns against overstating.
export type BullpenSideInput = { starterPitcherId: number | null; currentPitcherId: number | null };

export function bullpenUsageFactor(homeTeam: string, awayTeam: string, home: BullpenSideInput, away: BullpenSideInput): MomentumFactor {
  if (home.currentPitcherId === null && away.currentPitcherId === null) {
    return { key: "bullpenUsage", label: "Bullpen usage", lean: "unavailable", detail: "Game hasn't started yet." };
  }
  const inBullpen = (s: BullpenSideInput) => s.starterPitcherId !== null && s.currentPitcherId !== null && s.starterPitcherId !== s.currentPitcherId;
  const label = (s: BullpenSideInput) => (s.currentPitcherId === null ? "hasn't pitched yet" : inBullpen(s) ? "bullpen in" : "starter still going");
  return {
    key: "bullpenUsage",
    label: "Bullpen usage",
    lean: "even",
    detail: `${homeTeam}: ${label(home)} · ${awayTeam}: ${label(away)}`,
  };
}

// --- Resolves which pitcher was on the mound for `fielding`'s team most
// recently, by scanning the live plays backward - the team fielding a given
// play is the team NOT at bat (isTopInning true means away is batting, so
// home is fielding). Pure and exported so it's independently testable
// without needing a live fetch.
export function currentPitcherForTeam(
  plays: { isTopInning: boolean; currentPitcherId: number | null }[],
  fielding: "home" | "away"
): number | null {
  for (let i = plays.length - 1; i >= 0; i--) {
    const teamFielding = plays[i].isTopInning ? "home" : "away";
    if (teamFielding === fielding) return plays[i].currentPitcherId;
  }
  return null;
}
