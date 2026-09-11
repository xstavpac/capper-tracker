// The NFL Momentum calculation engine - pure functions only, no I/O. Kept
// separate from mlb-momentum.ts on purpose (not imported from it, even
// where the shape is similar) - same "one function per sport rather than a
// generic dispatcher" precedent nfl-game-pulse.ts already established
// relative to game-pulse.ts, so NFL's engine can be recalibrated or fixed
// without touching MLB's already-shipped one at all.
//
// Core guardrail (unchanged from MLB): Momentum is a RATE-OF-CHANGE signal,
// never an absolute win-probability read. computeMomentumTrend is the only
// function that produces the gauge's classification, and it looks at how
// win probability MOVED over a recent window of plays - never at its
// current absolute level.
//
// Unit convention: every function in this file takes/returns win
// probability as 0-100 PERCENTAGE POINTS, matching MLB's convention -
// deliberately NOT the raw 0-1 fraction ESPN's `homeWinPercentage` field
// uses (confirmed live against a real NFL game, see
// nfl-live-game-state.ts's header). The *100 conversion happens once, at
// the nfl-momentum-data.ts boundary, specifically so this threshold-bearing
// file never has to be read against two different possible scales.

export type NflMomentumClassification = "STRONG_HOME" | "LEAN_HOME" | "EVEN" | "LEAN_AWAY" | "STRONG_AWAY";

// ---------------------------------------------------------------------------
// Tentative thresholds - a reasonable placeholder, not a calibrated one, and
// NOT copied from MLB's constants (NFL's scoring/possession rhythm and its
// win-probability model's swing sizes are different enough that reusing
// MLB's tuned-for-baseball numbers would be a guess dressed up as reuse).
// Real calibration needs a backtest against real NFL win-probability series,
// which doesn't exist yet - Sunday's full slate is the first real volume.
// ---------------------------------------------------------------------------

// How many of the most recent win-probability observations the
// rate-of-change window covers. NFL's winprobability array is one entry per
// play (confirmed ~150-170 entries for a full game, a similar order of
// magnitude to MLB's per-at-bat granularity) - 10 plays is roughly a drive,
// long enough to smooth over a single play's noise.
export const NFL_MOMENTUM_WINDOW_PLAYS = 10;
// Early-game protection: fewer deltas than this and the read isn't trusted
// yet, however big the swing looks.
export const NFL_MOMENTUM_MIN_DELTAS_FOR_READ = 4;
// Cumulative home-win-percentage-POINT shift within the window (0-100
// scale - see file header). A single NFL touchdown in a close game can
// swing win probability by 10-20 points in one play, noticeably more per
// play than a single MLB at-bat typically does, so these thresholds sit
// higher than MLB's tentative 15/6.
export const NFL_MOMENTUM_STRONG_THRESHOLD = 20;
export const NFL_MOMENTUM_LEAN_THRESHOLD = 8;

export type NflMomentumTrend = {
  classification: NflMomentumClassification;
  // Signed sum of consecutive homeWinPercentage-point deltas across the
  // window - positive means win probability moved toward the home team over
  // that stretch. This, not any absolute probability, is what classification
  // is computed from.
  netShift: number;
  // Number of deltas the window actually had (entries considered - 1,
  // floored at 0).
  deltasConsidered: number;
  // Context for the UI only (0-100 scale) - never an input to
  // classification. Null before the game's first play exists.
  currentHomeWinPercentage: number | null;
};

export function computeNflMomentumTrend(points: { homeWinPercentage: number }[]): NflMomentumTrend {
  if (points.length === 0) {
    return { classification: "EVEN", netShift: 0, deltasConsidered: 0, currentHomeWinPercentage: null };
  }

  const window = points.slice(-NFL_MOMENTUM_WINDOW_PLAYS);
  let netShift = 0;
  for (let i = 1; i < window.length; i++) {
    netShift += window[i].homeWinPercentage - window[i - 1].homeWinPercentage;
  }
  const deltasConsidered = Math.max(0, window.length - 1);
  const currentHomeWinPercentage = points[points.length - 1].homeWinPercentage;

  if (deltasConsidered < NFL_MOMENTUM_MIN_DELTAS_FOR_READ) {
    return { classification: "EVEN", netShift, deltasConsidered, currentHomeWinPercentage };
  }

  let classification: NflMomentumClassification;
  if (netShift >= NFL_MOMENTUM_STRONG_THRESHOLD) classification = "STRONG_HOME";
  else if (netShift >= NFL_MOMENTUM_LEAN_THRESHOLD) classification = "LEAN_HOME";
  else if (netShift <= -NFL_MOMENTUM_STRONG_THRESHOLD) classification = "STRONG_AWAY";
  else if (netShift <= -NFL_MOMENTUM_LEAN_THRESHOLD) classification = "LEAN_AWAY";
  else classification = "EVEN";

  return { classification, netShift, deltasConsidered, currentHomeWinPercentage };
}

// ---------------------------------------------------------------------------
// Factors - each pure, each independently testable, each degrading to
// "unavailable" (never a fabricated lean) when its input data doesn't exist
// yet. Exactly the 7 factors named for this build (recent scoring, drive
// success, possession, yards/drive, turnovers, third-down performance,
// red-zone performance) - no 8th "situation" factor invented on top; the
// live situation object (down/distance/red zone/timeouts) instead feeds
// INTO the possession and red-zone factors below, per the live-state-over-
// new-historical-infra instruction this build followed.
// ---------------------------------------------------------------------------

export type NflMomentumFactorLean = "home" | "away" | "even" | "unavailable";
export type NflMomentumFactor = { key: string; label: string; lean: NflMomentumFactorLean; detail: string };

function leanFromCompare(home: number, away: number): NflMomentumFactorLean {
  return home === away ? "even" : home > away ? "home" : "away";
}

// --- Recent scoring: avg points scored over each team's last few finished
// games (point-in-time - the caller must only pass games strictly before
// today's Eastern day). Same shape as MLB's recentScoringFactor by design
// (both read GameResult directly, since neither TeamRecordSnapshot nor
// SituationalRateSnapshot track a rolling scoring average - confirmed by
// inspection, see the PR description), but NOT imported from
// mlb-momentum.ts - independent per this file's header.
export type NflRecentScoringInput = { teamName: string; avgPointsLastN: number | null; gamesConsidered: number };

export function recentScoringFactor(home: NflRecentScoringInput, away: NflRecentScoringInput): NflMomentumFactor {
  if (home.avgPointsLastN === null && away.avgPointsLastN === null) {
    return { key: "recentScoring", label: "Recent scoring", lean: "unavailable", detail: "No finished games yet this season." };
  }
  const h = home.avgPointsLastN ?? 0;
  const a = away.avgPointsLastN ?? 0;
  const fmt = (v: number | null) => (v === null ? "?" : v.toFixed(1));
  return {
    key: "recentScoring",
    label: "Recent scoring",
    lean: leanFromCompare(h, a),
    detail: `${home.teamName} ${fmt(home.avgPointsLastN)} pts/gm (L${home.gamesConsidered}) · ${away.teamName} ${fmt(away.avgPointsLastN)} pts/gm (L${away.gamesConsidered})`,
  };
}

// --- Drive success: each side's most recent completed drives (live, from
// the summary endpoint's drives.previous - see nfl-live-game-state.ts),
// scored by how many ended in points. Genuinely live game state, not a
// historical figure - matches the "prefer live data over new historical
// infrastructure" instruction, since NflTeamStatSnapshot has no per-drive
// data to draw on anyway.
export type NflDriveLike = { teamAbbreviation: string; isScore: boolean };

const RECENT_DRIVES_WINDOW = 5;

function recentScoreDriveRate(drives: NflDriveLike[], teamAbbreviation: string): { scores: number; total: number } {
  const teamDrives = drives.filter((d) => d.teamAbbreviation === teamAbbreviation).slice(-RECENT_DRIVES_WINDOW);
  return { scores: teamDrives.filter((d) => d.isScore).length, total: teamDrives.length };
}

export function driveSuccessFactor(
  homeTeam: string,
  awayTeam: string,
  homeAbbreviation: string | null,
  awayAbbreviation: string | null,
  previousDrives: NflDriveLike[]
): NflMomentumFactor {
  if (!homeAbbreviation || !awayAbbreviation || previousDrives.length === 0) {
    return { key: "driveSuccess", label: "Drive success", lean: "unavailable", detail: "No completed drives yet this game." };
  }
  const home = recentScoreDriveRate(previousDrives, homeAbbreviation);
  const away = recentScoreDriveRate(previousDrives, awayAbbreviation);
  if (home.total === 0 && away.total === 0) {
    return { key: "driveSuccess", label: "Drive success", lean: "unavailable", detail: "No completed drives yet this game." };
  }
  const homeRate = home.total > 0 ? home.scores / home.total : 0;
  const awayRate = away.total > 0 ? away.scores / away.total : 0;
  return {
    key: "driveSuccess",
    label: "Drive success",
    lean: leanFromCompare(homeRate, awayRate),
    detail: `${homeTeam} ${home.scores}/${home.total} scoring drives (last ${home.total}) · ${awayTeam} ${away.scores}/${away.total} (last ${away.total})`,
  };
}

// --- Possession: who has the ball RIGHT NOW (from drives.current.team, see
// nfl-live-game-state.ts) plus the live down/distance/field position from
// the situation sub-resource when available, backed by each side's
// cumulative time-of-possession split for the "who's controlling the game"
// context. Lean is driven by time of possession (the game-control signal),
// not by momentary "who's on offense" - the same "immediate state is
// context, not a fabricated lean" restraint MLB's baseOutFactor uses.
export type NflSituationLike = { down: number | null; distance: number | null; yardLine: number | null } | null;

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

export function possessionFactor(
  homeTeam: string,
  awayTeam: string,
  homeAbbreviation: string | null,
  awayAbbreviation: string | null,
  possessionTeamAbbreviation: string | null,
  homePossessionSeconds: number | null,
  awayPossessionSeconds: number | null,
  situation: NflSituationLike
): NflMomentumFactor {
  if (homePossessionSeconds === null && awayPossessionSeconds === null && !possessionTeamAbbreviation) {
    return { key: "possession", label: "Possession", lean: "unavailable", detail: "Game hasn't started yet." };
  }

  const possessingTeam =
    possessionTeamAbbreviation === homeAbbreviation ? homeTeam : possessionTeamAbbreviation === awayAbbreviation ? awayTeam : null;

  let liveText = possessingTeam ? `${possessingTeam} have the ball` : "Possession unknown";
  if (possessingTeam && situation?.down && situation?.distance && situation?.yardLine !== null && situation?.yardLine !== undefined) {
    liveText += ` · ${ordinal(situation.down)} & ${situation.distance}`;
  }

  const fmtTime = (s: number | null) => (s === null ? "?" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  const topText = `Time of possession: ${homeTeam} ${fmtTime(homePossessionSeconds)} · ${awayTeam} ${fmtTime(awayPossessionSeconds)}`;

  const lean: NflMomentumFactorLean =
    homePossessionSeconds === null || awayPossessionSeconds === null
      ? "unavailable"
      : leanFromCompare(homePossessionSeconds, awayPossessionSeconds);

  return { key: "possession", label: "Possession", lean, detail: `${liveText} · ${topText}` };
}

// --- Yards per drive: live boxscore totals (totalYards / totalDrives),
// each side - NflTeamStatSnapshot has no per-drive figure to draw on
// historically, but the live boxscore already computes both inputs per
// game.
export function yardsPerDriveFactor(
  homeTeam: string,
  awayTeam: string,
  homeYards: number | null,
  homeDrives: number | null,
  awayYards: number | null,
  awayDrives: number | null
): NflMomentumFactor {
  if (!homeDrives || !awayDrives || homeYards === null || awayYards === null) {
    return { key: "yardsPerDrive", label: "Yards per drive", lean: "unavailable", detail: "Not enough drives yet this game." };
  }
  const homeYpd = homeYards / homeDrives;
  const awayYpd = awayYards / awayDrives;
  return {
    key: "yardsPerDrive",
    label: "Yards per drive",
    lean: leanFromCompare(homeYpd, awayYpd),
    detail: `${homeTeam} ${homeYpd.toFixed(1)} yds/drive · ${awayTeam} ${awayYpd.toFixed(1)} yds/drive`,
  };
}

// --- Turnovers: fewer is better (mirrors NFL Game Pulse's wonTurnoverBattle
// question - see nfl-game-pulse-situations.ts) - equal counts is no lean,
// same tie handling.
export function turnoversFactor(
  homeTeam: string,
  awayTeam: string,
  homeTurnovers: number | null,
  awayTurnovers: number | null
): NflMomentumFactor {
  if (homeTurnovers === null || awayTurnovers === null) {
    return { key: "turnovers", label: "Turnovers", lean: "unavailable", detail: "Not available yet this game." };
  }
  const lean: NflMomentumFactorLean = homeTurnovers === awayTurnovers ? "even" : homeTurnovers < awayTurnovers ? "home" : "away";
  return {
    key: "turnovers",
    label: "Turnovers",
    lean,
    detail: `${homeTeam} ${homeTurnovers} · ${awayTeam} ${awayTurnovers}`,
  };
}

// --- Third-down performance: live boxscore made/attempted efficiency.
export function thirdDownFactor(
  homeTeam: string,
  awayTeam: string,
  homeMade: number | null,
  homeAttempted: number | null,
  awayMade: number | null,
  awayAttempted: number | null
): NflMomentumFactor {
  if (!homeAttempted || !awayAttempted || homeMade === null || awayMade === null) {
    return { key: "thirdDown", label: "Third-down performance", lean: "unavailable", detail: "No third-down attempts yet this game." };
  }
  const homePct = homeMade / homeAttempted;
  const awayPct = awayMade / awayAttempted;
  return {
    key: "thirdDown",
    label: "Third-down performance",
    lean: leanFromCompare(homePct, awayPct),
    detail: `${homeTeam} ${homeMade}/${homeAttempted} (${Math.round(homePct * 100)}%) · ${awayTeam} ${awayMade}/${awayAttempted} (${Math.round(awayPct * 100)}%)`,
  };
}

// --- Red-zone performance: live boxscore scores/attempts efficiency, with
// the live situation's isRedZone flag surfaced when the game is currently
// inside one team's red zone - the "immediate threat" context, same role
// MLB's base/out factor plays.
export function redZoneFactor(
  homeTeam: string,
  awayTeam: string,
  homeScores: number | null,
  homeAttempts: number | null,
  awayScores: number | null,
  awayAttempts: number | null,
  currentlyInRedZone: boolean,
  possessingTeam: string | null
): NflMomentumFactor {
  if (!homeAttempts && !awayAttempts) {
    return { key: "redZone", label: "Red-zone performance", lean: "unavailable", detail: "No red-zone trips yet this game." };
  }
  const homePct = homeAttempts ? (homeScores ?? 0) / homeAttempts : null;
  const awayPct = awayAttempts ? (awayScores ?? 0) / awayAttempts : null;
  const lean: NflMomentumFactorLean = homePct === null || awayPct === null ? "unavailable" : leanFromCompare(homePct, awayPct);

  const fmt = (scores: number | null, attempts: number | null) =>
    attempts ? `${scores ?? 0}/${attempts} (${Math.round(((scores ?? 0) / attempts) * 100)}%)` : "0/0";
  let detail = `${homeTeam} ${fmt(homeScores, homeAttempts)} · ${awayTeam} ${fmt(awayScores, awayAttempts)}`;
  if (currentlyInRedZone && possessingTeam) detail += ` · ${possessingTeam} currently driving in the red zone`;

  return { key: "redZone", label: "Red-zone performance", lean, detail };
}
