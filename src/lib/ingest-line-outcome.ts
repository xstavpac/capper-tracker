// Per-line results of an unattended import (runCatalogImportForUser's onLineOutcome), and the date rules the bot API
// (API_TOKEN batches) matches games by. Pure: no database, no network.
import type { BetType, Period } from "@prisma/client";
import { addDaysToDateKey, easternDateKey } from "@/lib/dates";

export type LineGame = { away: string; home: string; startsAt: string };

export type LineRejectReason =
  | "combined_pick" // more than one team or bet on one line (a parlay / MLP / "A + B")
  | "league_not_allowed" // resolved to a league outside the allowlist
  | "duplicate" // the same pick is already logged (or appears earlier in this batch under another wording)
  | "duplicate_in_request" // the same line text twice in one batch: the second one
  | "pick_limit" // the plan's pick limit refused the batch's inserts
  | "no_game_found" // no scheduled game matched
  | "doubleheader_final" // a doubleheader whose every leg was already final
  | "game_already_final" // real-time ingest (Telegram) only: the team's only game was final when it was posted
  | "invalid_odds"
  | "total_without_line" // a TOTAL with no number
  | "unparseable" // no pick could be read from the line
  | "no_capper" // a pick with no capper header above it
  | "parlay_not_supported" // an MLP parlay line: not imported by the unattended import
  | "error"; // anything else (the detail says what)

export type LineReviewReason = "ambiguous_team" | "ambiguous_player" | "missing_total_line" | "capper_name" | "far_future_game";

export type ReviewCandidate = { label: string; league: string | null; game: LineGame | null };

export type LineOutcome =
  | {
      status: "accepted";
      capperName: string;
      league: string;
      // null only for a league with no game feed (the pick is stored with placeholder teams, as the import always has)
      game: LineGame | null;
      market: BetType;
      period: Period;
      line: number | null;
      odds: number;
      pickId: string;
    }
  | {
      status: "needs_review";
      capperName: string;
      reason: LineReviewReason;
      // Index into CatalogImportResult.questions: the review item drafted from it is drafts[questionIndex]. The shared
      // ingest core (ingest-batch.ts) fills reviewItemId and the candidates' games once the items are written.
      questionIndex: number;
      candidates: ReviewCandidate[];
      reviewItemId?: string;
    }
  | { status: "rejected"; capperName: string; reason: LineRejectReason; detail?: string };

export type LineOutcomeListener = (raw: string, outcome: LineOutcome) => void;

// ---- the bot API's day rule ----
//
// requestDay: the Eastern-time calendar date (YYYY-MM-DD) when the request arrived; midnight ET is the cutoff (no
// 6 a.m. slate rollover). A pick that names a day or date is matched to that day's game; otherwise to the team's game
// on requestDay (upcoming, live or final); a team with no game that day gets its next upcoming game.
export type TokenDayRule = { requestDay: string };

export function tokenRequestDay(now: Date = new Date()): string {
  return easternDateKey(now);
}

const WEEKDAYS: [RegExp, number][] = [
  // Sunday only in full: "Sun" is the WNBA's Connecticut Sun.
  [/^sunday$/, 0],
  [/^mon(day)?$/, 1],
  [/^tue(s(day)?)?$/, 2],
  [/^wed(s|nesday)?$/, 3],
  [/^thu(r(s(day)?)?)?$/, 4],
  [/^fri(day)?$/, 5],
  [/^sat(urday)?$/, 6],
];

// Day of the week (0 = Sunday) of a YYYY-MM-DD key, by the calendar (no time zone involved).
function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const pad = (n: number) => String(n).padStart(2, "0");

// "11/27" or "11/27/26" / "11/27/2026". Not a fraction of units ("1/2u", "1/2 unit"), not part of a longer number.
const DATE_RE = /(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/.])(?!\s*u(nits?)?\b)/i;

// The day a pick's own text names, as a YYYY-MM-DD key, or null when it names none.
//   - "today" / "tonight" -> requestDay; "tomorrow" -> the next day
//   - a weekday ("Thursday", "Thurs", "Thu") -> the next such day on or after requestDay (today when it is that day)
//   - a date ("11/27", "11/27/26") -> that date, in the year that puts it nearest requestDay
// When the text names more than one, a date wins over a weekday (it is the more specific).
export function namedPickDay(text: string, requestDay: string): string | null {
  const m = DATE_RE.exec(text);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const baseYear = Number(requestDay.slice(0, 4));
      if (m[3]) {
        const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
        return `${y}-${pad(month)}-${pad(day)}`;
      }
      const options = [baseYear - 1, baseYear, baseYear + 1].map((y) => `${y}-${pad(month)}-${pad(day)}`);
      const dist = (k: string) => Math.abs(Date.parse(k + "T12:00:00Z") - Date.parse(requestDay + "T12:00:00Z"));
      return options.sort((a, b) => dist(a) - dist(b))[0];
    }
  }
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (!word) continue;
    if (word === "today" || word === "tonight") return requestDay;
    if (word === "tomorrow") return addDaysToDateKey(requestDay, 1);
    const wd = WEEKDAYS.find(([re]) => re.test(word));
    if (wd) {
      const ahead = (wd[1] - weekdayOf(requestDay) + 7) % 7;
      return addDaysToDateKey(requestDay, ahead);
    }
  }
  return null;
}
