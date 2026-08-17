// The DATA layer's pregame counterpart to facts.ts's getEvaluationEventFacts
// (Build Step 6) - sourced from OddsSnapshot (today's cached odds fetch)
// instead of GameResult (a graded game's stored result), so a matchup can be
// evaluated before it's been played. Read-only: looks up today's already-
// cached snapshot directly via Prisma, never calls getOddsForSport's own
// fetch-if-missing path (which can upsert a new OddsSnapshot row) - this
// function returns null rather than ever writing anything.
import { prisma } from "@/lib/prisma";
import { easternDateKey } from "@/lib/dates";
import type { OddsGame } from "@/server/data/odds";

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
  awayTeam: string
): Promise<PregameEventFacts | null> {
  const fetchDate = easternDateKey(new Date());

  const snapshot = await prisma.oddsSnapshot.findUnique({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
  });
  if (!snapshot) return null;

  const games = snapshot.data as unknown as OddsGame[];
  const match = games.find((g) => g.homeTeam === homeTeam && g.awayTeam === awayTeam);
  if (!match) return null;

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
