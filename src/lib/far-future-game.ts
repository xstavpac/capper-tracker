// A pick whose matched game starts far after the import is more often the wrong game (the intended one was live
// or just finished, and the matcher rolled to the team's next one) than a genuine advance post. Such a pick is
// still resolved, but never saved silently: the manual import shows a warning on its row and waits for the user
// to confirm it, and the Telegram ingest parks it in the review queue (bulk-import-core importPicksForUser's
// holdFarFuture). Pure, so the browser form and the server share the one rule.
import { APP_TIME_ZONE } from "@/lib/dates";

const HOUR_MS = 3600000;

// How far past the import time a matched game may start before the pick is flagged, per sport label (Sport.name /
// ParsedPick.sportName, upper-cased). Daily leagues play again within a day or two, so a game 36+ hours out is
// usually the wrong one; weekly football slates are posted up to a week ahead.
export const FAR_FUTURE_HOURS_BY_SPORT: Record<string, number> = {
  NBA: 36,
  NHL: 36,
  MLB: 36,
  NCAAB: 36,
  WNBA: 36,
  NFL: 8 * 24,
  NCAAF: 8 * 24,
};

// Any sport not in the map (KBO, CFL, ...) gets the daily-league threshold.
export const DEFAULT_FAR_FUTURE_HOURS = 36;

export function farFutureHoursFor(sportName: string): number {
  return FAR_FUTURE_HOURS_BY_SPORT[sportName.trim().toUpperCase()] ?? DEFAULT_FAR_FUTURE_HOURS;
}

const ms = (t: Date | string | number) => (typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : t.getTime());

export function isFarFutureGame(sportName: string, gameTime: Date | string, importedAt: Date | number): boolean {
  return ms(gameTime) - ms(importedAt) > farFutureHoursFor(sportName) * HOUR_MS;
}

// Whole days from the import to the game, at least 1.
export function daysAway(gameTime: Date | string, importedAt: Date | number): number {
  return Math.max(1, Math.round((ms(gameTime) - ms(importedAt)) / (24 * HOUR_MS)));
}

export function formatFarFutureDate(gameTime: Date | string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(typeof gameTime === "string" ? new Date(gameTime) : gameTime);
}

// The row warning: "Game is 3 days away: Sat, Nov 29, 7:30 PM. Is this the right game?"
export function farFutureWarning(gameTime: Date | string, importedAt: Date | number): string {
  const n = daysAway(gameTime, importedAt);
  return `Game is ${n} ${n === 1 ? "day" : "days"} away: ${formatFarFutureDate(gameTime)}. Is this the right game?`;
}
