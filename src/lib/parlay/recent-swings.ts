// Recent swings for Consensus Hybrid: how far a team's last few finished games
// landed from the lines posted for them. The server (server/data/recent-
// swings.ts) reads the scores and the small stored-line values; this file is the
// pure part - the sign conventions, which stored line belongs to a game, and the
// per-team assembly - so it is provable without a database. Client-safe.
//
// Sign conventions (all from the TEAM's side):
//   margin       = team score - opponent score (a win is positive)
//   postedSpread = the spread posted for this team: a favorite is negative
//                  (-7), an underdog positive (+7); the away side is the home
//                  spread negated
//   coverMargin  = margin + postedSpread - positive means the team covered by
//                  that much (a -7 favorite winning by 10: +3; a +7 underdog
//                  losing by 4: +3; a -7 favorite winning by 3: -4)
//   totalMiss    = actualTotal - postedTotal - positive means the game went over
//
// Which stored line belongs to a game:
//   - The snapshot rows hold one captured game list per (sport, Eastern day),
//     and a game can sit in several days' rows (the seed has no upper date
//     bound), so the same event can have several captures. The LATEST row
//     (fetchDate) holds the capture closest to kickoff; a market's own
//     last_update after kickoff would be an in-play price and is never used.
//   - Per market (spread, total) independently: the latest capture that has it.
//   - hoursBeforeStart = kickoff minus the market's own last_update, or, when
//     the book gave none (older rows), minus the start of the capture's Eastern
//     day (an upper bound - the row was written some time that day). With both
//     markets used, the older of the two.
//   - A doubleheader has two events the same Eastern day: the score's game
//     number (1 or 2) picks the first or second by start time; without one, the
//     event whose start is closest to the score's.
import { closestByTime, easternDayStart, sameEasternDay } from "@/lib/dates";
import { CROSS_SOURCE_TEAM_ALIASES, normalizeTeamName, teamNamesMatch } from "@/lib/team-name-match";

export type SwingGame = {
  // ISO start time of the finished game (game_results.gameDate).
  date: string;
  opponent: string;
  home: boolean;
  actualTotal: number;
  postedTotal: number | null;
  totalMiss: number | null;
  margin: number;
  postedSpread: number | null;
  coverMargin: number | null;
  lineSource: "stored" | "missing";
  hoursBeforeStart: number | null;
};

// A finished game: game_results' score columns, nothing else.
export type SwingScore = {
  externalId: string;
  gameDate: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  gameNumber: number | null;
};

// One captured event from one snapshot row, cut to the main spread and total.
// homeSpread is the HOME team's point; times are ISO strings or null.
export type StoredLine = {
  fetchDate: string;
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  homeSpread: number | null;
  spreadUpdatedAt: string | null;
  total: number | null;
  totalUpdatedAt: string | null;
};

const HOUR_MS = 3600_000;
// With a game number, the only event on the day must also start this close to
// the score's start, or it is the other game of a doubleheader that is missing.
const DOUBLEHEADER_START_TOLERANCE_MS = 3 * HOUR_MS;

// The spellings an odds feed may use for a score-feed team name: the name
// itself, and its alias row's Odds API spelling (team-name-match.ts).
export function oddsSpellings(name: string, sportKey: string): string[] {
  const out = new Set([name]);
  for (const [scoreFeed, oddsApi] of CROSS_SOURCE_TEAM_ALIASES[sportKey] ?? []) {
    if (normalizeTeamName(scoreFeed) === normalizeTeamName(name)) out.add(oddsApi);
  }
  return Array.from(out);
}

type Pick1 = { value: number; hoursBeforeStart: number };

// The latest capture's value for one market, from the event's captures.
function latestMarket(
  captures: StoredLine[],
  commence: number,
  read: (c: StoredLine) => { value: number | null; updatedAt: string | null }
): Pick1 | null {
  let best: { fetchDate: string; value: number; capturedAt: number } | null = null;
  for (const c of captures) {
    const { value, updatedAt } = read(c);
    if (value === null || !Number.isFinite(value)) continue;
    const updated = updatedAt ? new Date(updatedAt).getTime() : NaN;
    // Priced after kickoff: in play, not a posted line.
    if (Number.isFinite(updated) && updated > commence) continue;
    const capturedAt = Number.isFinite(updated) ? updated : easternDayStart(c.fetchDate).getTime();
    if (best === null || c.fetchDate > best.fetchDate || (c.fetchDate === best.fetchDate && capturedAt > best.capturedAt)) {
      best = { fetchDate: c.fetchDate, value, capturedAt };
    }
  }
  return best ? { value: best.value, hoursBeforeStart: Math.max(0, (commence - best.capturedAt) / HOUR_MS) } : null;
}

export type ChosenLine = { homeSpread: number | null; total: number | null; hoursBeforeStart: number | null };

// The stored line for a finished game, or null when none belongs to it.
export function chooseLine(score: SwingScore, lines: StoredLine[], sportKey: string): ChosenLine | null {
  const played = new Date(score.gameDate);
  const sameGame = lines.filter(
    (l) =>
      teamNamesMatch(l.homeTeam, score.homeTeam, sportKey) &&
      teamNamesMatch(l.awayTeam, score.awayTeam, sportKey) &&
      sameEasternDay(new Date(l.commenceTime), played)
  );
  if (sameGame.length === 0) return null;

  const byEvent = new Map<string, StoredLine[]>();
  for (const l of sameGame) byEvent.set(l.eventId, [...(byEvent.get(l.eventId) ?? []), l]);
  const events = Array.from(byEvent.values())
    .map((captures) => ({ captures, start: new Date(captures[0].commenceTime).getTime() }))
    .sort((a, b) => a.start - b.start);

  let event = events[0];
  if (events.length >= 2) {
    event = score.gameNumber != null && score.gameNumber >= 1 && score.gameNumber <= events.length ? events[score.gameNumber - 1] : closestByTime(events, (e) => e.start, played.getTime());
  } else if (score.gameNumber != null && Math.abs(event.start - played.getTime()) > DOUBLEHEADER_START_TOLERANCE_MS) {
    return null;
  }

  const spread = latestMarket(event.captures, event.start, (c) => ({ value: c.homeSpread, updatedAt: c.spreadUpdatedAt }));
  const total = latestMarket(event.captures, event.start, (c) => ({ value: c.total, updatedAt: c.totalUpdatedAt }));
  if (!spread && !total) return null;
  const hours = [spread, total].filter((p): p is Pick1 => p !== null).map((p) => p.hoursBeforeStart);
  return { homeSpread: spread?.value ?? null, total: total?.value ?? null, hoursBeforeStart: Math.max(...hours) };
}

// One finished game from one team's side. `line` is the chosen stored line, or
// null for none (the scores alone).
export function swingForTeam(score: SwingScore, isHome: boolean, line: ChosenLine | null): SwingGame {
  const margin = isHome ? score.homeScore - score.awayScore : score.awayScore - score.homeScore;
  const actualTotal = score.homeScore + score.awayScore;
  const postedSpread = line?.homeSpread == null ? null : isHome ? line.homeSpread : -line.homeSpread;
  const postedTotal = line?.total ?? null;
  const stored = postedSpread !== null || postedTotal !== null;
  return {
    date: new Date(score.gameDate).toISOString(),
    opponent: isHome ? score.awayTeam : score.homeTeam,
    home: isHome,
    actualTotal,
    postedTotal,
    totalMiss: postedTotal === null ? null : actualTotal - postedTotal,
    margin,
    postedSpread,
    coverMargin: postedSpread === null ? null : margin + postedSpread,
    lineSource: stored ? "stored" : "missing",
    hoursBeforeStart: stored ? line!.hoursBeforeStart : null,
  };
}

// Every team in `scores` with its last `n` games, most recent first. Keyed by the
// score feed's team name.
export function assembleSwings(sportKey: string, scores: SwingScore[], lines: StoredLine[], n: number): Record<string, SwingGame[]> {
  const byTeam = new Map<string, { score: SwingScore; isHome: boolean }[]>();
  const add = (team: string, score: SwingScore, isHome: boolean) => byTeam.set(team, [...(byTeam.get(team) ?? []), { score, isHome }]);
  for (const s of scores) {
    add(s.homeTeam, s, true);
    add(s.awayTeam, s, false);
  }
  const chosen = new Map<string, ChosenLine | null>();
  const lineFor = (s: SwingScore) => {
    if (!chosen.has(s.externalId)) chosen.set(s.externalId, chooseLine(s, lines, sportKey));
    return chosen.get(s.externalId)!;
  };
  const out: Record<string, SwingGame[]> = {};
  for (const [team, games] of Array.from(byTeam.entries())) {
    games.sort((a, b) => {
      const t = new Date(b.score.gameDate).getTime() - new Date(a.score.gameDate).getTime();
      return t !== 0 ? t : a.score.externalId < b.score.externalId ? -1 : a.score.externalId > b.score.externalId ? 1 : 0;
    });
    out[team] = games.slice(0, n).map((g) => swingForTeam(g.score, g.isHome, lineFor(g.score)));
  }
  return out;
}
