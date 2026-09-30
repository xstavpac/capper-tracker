// The DATA layer's pregame counterpart to facts.ts's getEvaluationEventFacts
// (Build Step 6) - sourced from OddsSnapshot (today's cached odds fetch)
// instead of GameResult (a graded game's stored result), so a matchup can be
// evaluated before it's been played. Read-only: looks up today's already-
// cached snapshot directly via Prisma, never calls getOddsForSport's own
// fetch-if-missing path (which can upsert a new OddsSnapshot row) - this
// function returns null rather than ever writing anything.
import { easternDateKey, sameEasternDay, closestByTime } from "@/lib/dates";
import type { OddsGame } from "@/server/data/odds";
import { getPregameSnapshotGames } from "@/server/data/odds-projections";

export type PregameEventFacts = {
  favTeam: string | null;
  totalLine: number | null;
  lineSource: string;
  commenceTime: Date;
};

// Bookmaker selection: the first bookmaker (array order) that carries the
// requested market - the same convention grading.ts's private findMarket/
// deriveLedgerFields already use everywhere else this app derives a
// favorite/total from OddsSnapshot data (GameResult's own ledger fields,
// odds.ts's findMarketPrice/findMarketTotalLine). Not imported from
// grading.ts (those helpers are module-private, not exported) - reimplemented
// here identically, same "cite the established convention, don't reach
// across a domain boundary for a private helper" precedent
// observations.ts already set for GameResult.favTeam's own derivation.
//
// "Closest to actual game time" (this project's closing-line principle) was
// considered and explicitly NOT implemented, because the real data doesn't
// support it meaningfully: OddsSnapshot caches exactly ONE fetch per sport
// per Eastern day (getOddsForSport), typically hours before that day's games
// start (see schema.prisma's GameResult comment on this same limitation).
// Checked against a real stored snapshot (2026-08-17, baseball_mlb): every
// bookmaker's own `last_update` for a given game clustered within about a
// minute of each other (all from that single daily fetch), while
// commenceTime was many hours later - so no bookmaker in a snapshot is
// meaningfully "closer to game time" than any other; the sub-minute spread
// between bookmakers is fetch-order noise, not a real closing-line signal.
// Picking by last_update would just be a second, differently-arbitrary
// tiebreaker, not a more principled one - so this reuses the app's one
// existing convention instead of inventing another.
function findMarket(game: OddsGame, key: string) {
  for (const b of game.bookmakers) {
    const m = b.markets.find((m) => m.key === key);
    if (m) return m;
  }
  return undefined;
}

// Where a pregame lookup gets a day's board. The default reads it from
// Postgres as a slim projection (odds-projections.ts) on every call - a few kB,
// not the ~70-320 kB full board this file used to pull per call. A cron run that
// evaluates many games (persistPregameDecayDeltaGames -> runModelDefinition)
// passes one createPregameSnapshotSource() through so each day's board is read
// once per run and reused for every unstarted game.
export type PregameSnapshotSource = (sportKey: string, fetchDate: string) => Promise<OddsGame[]>;

export const readPregameSnapshot: PregameSnapshotSource = getPregameSnapshotGames;

export function createPregameSnapshotSource(read: PregameSnapshotSource = getPregameSnapshotGames): PregameSnapshotSource {
  const memo = new Map<string, Promise<OddsGame[]>>();
  return (sportKey, fetchDate) => {
    const key = sportKey + ":" + fetchDate;
    let hit = memo.get(key);
    if (!hit) {
      hit = read(sportKey, fetchDate);
      // A failed read must not poison the rest of the run.
      hit.catch(() => memo.delete(key));
      memo.set(key, hit);
    }
    return hit;
  };
}

// The match-and-derive step, over an already-loaded board - pure, so the parity
// test can run it over the full stored board and the projection and compare.
// `now` is a parameter for the same reason (fetchDate is derived from it too).
export function derivePregameEventFacts(
  games: OddsGame[],
  homeTeam: string,
  awayTeam: string,
  now: Date
): PregameEventFacts | null {
  // games is the day's whole cached snapshot, no longer pre-narrowed to
  // today/tomorrow by getOddsForSport (it can now span a full week for a
  // sport like NFL) - matching by team name alone here would risk pulling a
  // later same-team rematch's line into "today's" pregame facts, so this
  // scopes to today (the fetchDate this row is keyed on, same reference as
  // the lookup above) and, if that still leaves more than one candidate,
  // disambiguates with closestByTime - the same pattern resolveOddsGame uses
  // in odds.ts. A team pair with no same-day candidate returns null rather
  // than silently matching a different day's game.
  const candidates = games.filter((g) => g.homeTeam === homeTeam && g.awayTeam === awayTeam);
  const sameDay = candidates.filter((g) => sameEasternDay(new Date(g.commenceTime), now));
  if (sameDay.length === 0) return null;
  const match = closestByTime(sameDay, (g) => new Date(g.commenceTime).getTime(), now.getTime());

  const h2h = findMarket(match, "h2h");
  const homeOutcome = h2h?.outcomes.find((o) => o.name === match.homeTeam);
  const awayOutcome = h2h?.outcomes.find((o) => o.name === match.awayTeam);
  const favTeam =
    homeOutcome && awayOutcome ? (homeOutcome.price < awayOutcome.price ? match.homeTeam : match.awayTeam) : null;

  const totals = findMarket(match, "totals");
  const totalLine = totals?.outcomes.find((o) => o.point !== undefined)?.point ?? null;

  return {
    favTeam,
    totalLine,
    lineSource: "odds_snapshot",
    commenceTime: new Date(match.commenceTime),
  };
}

// KNOWN LIMITATION - odds staleness, not a bug in this function: because
// OddsSnapshot caches exactly ONE fetch per sport per Eastern day (see
// findMarket's comment above), a pregame evaluation run for a game later
// that day is necessarily reading odds from that single morning fetch, not
// odds anywhere close to actual game time. A line can move meaningfully in
// the hours between that fetch and first pitch, and this function has no
// way to know whether - or how much - it did; it always returns whatever
// was cached, with no staleness signal attached. Closing this gap means
// fetching odds more than once a day (a scheduling/cost change to
// getOddsForSport's own cron cadence), not a code change here - same
// "documented seam, not silently worked around" treatment as the
// pitcher-entity-resolution gap (orchestrate.ts / run-diff-era.ts) and the
// original Decay Delta same-day-exclusion divergence (observations.ts).
export async function getPregameEventFacts(
  sportKey: string,
  homeTeam: string,
  awayTeam: string,
  readSnapshot: PregameSnapshotSource = readPregameSnapshot
): Promise<PregameEventFacts | null> {
  const now = new Date();
  const fetchDate = easternDateKey(now);
  const games = await readSnapshot(sportKey, fetchDate);
  return derivePregameEventFacts(games, homeTeam, awayTeam, now);
}
