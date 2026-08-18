import { getOddsForSport, getLiveScoresForSport, matchScoreToGame, LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { sameEasternDay } from "@/lib/dates";
import { shortTeamName } from "@/lib/pick-team-group";
import { getTeamColor } from "@/lib/team-colors";

export type TickerGame = {
  id: string;
  sportKey: string;
  sportLabel: string;
  homeTeam: string;
  awayTeam: string;
  homeShort: string;
  awayShort: string;
  commenceTime: string;
  status: "preview" | "live" | "final";
  homeScore: number | null;
  awayScore: number | null;
  inningHalf: string | null;
  inningOrdinal: string | null;
  accentColor: string;
};

// Public marketing-page ticker's data source. Deliberately reuses the same
// getOddsForSport/getLiveScoresForSport the authenticated /live page runs
// on (see live/page.tsx) rather than a separate fetch path - same
// OddsSnapshot cache, same live score sources, same season gating, so this
// never drifts from what the real product shows.
//
// Scoped to RESOLVABLE_SPORT_KEYS, not the full LIVE_SPORTS list - NHL is
// in LIVE_SPORTS (odds display only) but has no real live-score source
// wired up (getLiveScoresForSport returns [] for it), so it can never show
// a real score or LIVE state here; a ticker with no live/score data for a
// sport isn't "genuinely live," so it's left out rather than shown as a
// permanently-blank segment.
export async function getLiveTickerGames(): Promise<TickerGame[]> {
  const perSport = await Promise.all(
    RESOLVABLE_SPORT_KEYS.map(async (sportKey) => {
      const sportLabel = LIVE_SPORTS.find((s) => s.key === sportKey)?.label ?? sportKey;
      const [allOdds, scores] = await Promise.all([getOddsForSport(sportKey), getLiveScoresForSport(sportKey)]);

      // Restricts to today's Eastern calendar day only - the ticker's whole
      // point is "what's happening today," not a running feed of everything
      // upcoming. sameEasternDay alone still lets through a not-yet-started
      // later-today game (it compares calendar dates, not time-of-day), so
      // this isn't just "started or later today" - it's "today," full stop.
      // A prior `|| gameDate > now` clause here let ANY future day's games
      // through too (NFL odds are posted for the whole week at once), which
      // is what caused games 2-3 days out to show up in the ticker.
      const now = new Date();
      const todaysOdds = allOdds.filter((game) => {
        const gameDate = new Date(game.commenceTime);
        return sameEasternDay(gameDate, now);
      });

      return todaysOdds.map((game): TickerGame => {
        const score = matchScoreToGame(scores, game);
        return {
          id: game.id,
          sportKey,
          sportLabel,
          homeTeam: game.homeTeam,
          awayTeam: game.awayTeam,
          homeShort: shortTeamName(game.homeTeam, sportLabel),
          awayShort: shortTeamName(game.awayTeam, sportLabel),
          commenceTime: game.commenceTime,
          status: score?.status ?? "preview",
          homeScore: parseScore(score, game.homeTeam),
          awayScore: parseScore(score, game.awayTeam),
          inningHalf: score?.inningHalf ?? null,
          inningOrdinal: score?.inningOrdinal ?? null,
          accentColor: getTeamColor(sportKey, game.homeTeam) ?? "#64748B",
        };
      });
    })
  );

  // Interleaved by commence time (not grouped by sport) so the ticker reads
  // as one continuous "what's happening right now across every sport" feed
  // rather than four separate single-sport blocks back to back.
  return perSport.flat().sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime());
}

function parseScore(score: { scores: { name: string; score: string }[] | null } | undefined, teamName: string): number | null {
  const raw = score?.scores?.find((s) => s.name === teamName)?.score;
  if (raw === undefined) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}
