"use server";

import { requireUser } from "@/server/auth";
import { parseCatalog, parseSupportedMlbProp } from "@/lib/parse-catalog";
import type { LiveTeam } from "@/lib/live-team-fallback";
import { recoverUnresolvedLines, type RecoverUnresolvedResult } from "@/lib/recover-unresolved-lines";
import { parsePlayerProp } from "@/lib/bet-line";
import { getLiveScoresForSport, getOddsForSport, LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { getCachedNflRoster } from "@/server/data/nfl-roster-cache";
import { getCachedNhlRoster } from "@/server/data/nhl-roster-cache";
import { getCachedMlbRoster } from "@/server/data/mlb-roster-cache";
import { getImportFeedTeams } from "@/server/data/import-feed-teams";
import { parseNhlPlayerProp } from "@/lib/nhl-prop";

// Last-resort resolver for catalog lines the browser-side parser left in its
// `unresolved` list (Variant 1 - see live-team-fallback.ts's header), plus
// (2026-09) a second, independent fallback for bare NFL player-prop lines
// with no team prefix at all ("Patrick Mahomes Over 225 Passing Yards", or
// (2026-09, later) just "Gibbs Over 65.5 Rushing Yards" - see
// player-roster-fallback.ts). Runs only when there ARE unresolved lines,
// only server-side. The team-name fallback matches against live data (team
// names) the app fetches fresh each time; the roster fallback matches
// against getCachedNflRoster's cached table instead (see
// server/data/nfl-roster-cache.ts and scripts/load-nfl-roster.ts) - a
// bulk-import paste never triggers a live ESPN roster request. Neither
// fallback ever invents a team or player: a line resolves only on an
// EXACT-ONE match, everything else - including a collision between two or
// more candidates - stays unresolved. The one collision that is not a dead
// end is a bare surname shared by 2+ rostered players: it comes back as a pick
// awaiting the user's "which player?" answer, never as a guess.
//
// A player-prop-shaped line is routed to the roster fallback ONLY, never
// the team-name fallback below: a bare player prop was never a team pick to
// begin with, and resolveLineAgainstLiveTeams matches on live team names/
// prefixes with no notion that a matched word could be sitting right after a
// player's own first name - the same class of false-positive collision the
// #83 fix guards against in parse-catalog.ts's detectSport, but in this
// separate fallback implementation, which that fix doesn't touch (confirmed
// live: "Rashee Rice Over 59.5 Receiving Yards" against a live board
// containing "Rice Owls" resolves via resolveLineAgainstLiveTeams's own
// "prefix" match today, independent of #83). Excluding player-prop-shaped
// lines from that path here closes the exposure for exactly the line shape
// this fallback targets, with no change to live-team-fallback.ts itself.
//
// The actual per-line resolution + capper-attribution loop lives in
// lib/recover-unresolved-lines.ts (a plain module, no "use server"/auth
// dependency) - this file's job is only to fetch the live team data (and
// read the cached roster table) that pure function needs and delegate to
// it.
export type { RecoverUnresolvedResult };

// Every distinct team name currently on the live schedule (ESPN) or the
// pregame odds board (Odds API snapshot) for a resolvable sport - the same
// two feeds resolveGameForNickname / lookupGame already match picks against.
//
// `completeSports` lists the sport labels whose slate is trustworthy enough to
// choose between two players sharing a surname (see SlateContext in
// player-roster-fallback.ts): both feeds answered and neither came back empty.
// The score feed only spans ~yesterday..tomorrow and the odds board only lists
// games not yet started, so losing either one can hide a team that does have
// a game this week - and "only one candidate is playing" would then be false.
async function gatherLiveTeamNames(): Promise<{ teams: LiveTeam[]; completeSports: string[] }> {
  const out: LiveTeam[] = [];
  const completeSports: string[] = [];
  await Promise.all(
    RESOLVABLE_SPORT_KEYS.map(async (key) => {
      const label = LIVE_SPORTS.find((s) => s.key === key)?.label ?? key;
      let failed = false;
      const [scores, odds] = await Promise.all([
        getLiveScoresForSport(key).catch(() => ((failed = true), [])),
        getOddsForSport(key).catch(() => ((failed = true), [])),
      ]);
      if (!failed && scores.length > 0 && odds.length > 0) completeSports.push(label);
      for (const g of scores) {
        if (g.homeTeam) out.push({ sport: label, name: g.homeTeam });
        if (g.awayTeam) out.push({ sport: label, name: g.awayTeam });
      }
      for (const g of odds) {
        if (g.homeTeam) out.push({ sport: label, name: g.homeTeam });
        if (g.awayTeam) out.push({ sport: label, name: g.awayTeam });
      }
    })
  );
  return { teams: out, completeSports };
}

export async function recoverUnresolvedPicksAction(
  text: string,
  knownCapperNames: string[] = []
): Promise<RecoverUnresolvedResult> {
  await requireUser();

  // Fetched BEFORE parseCatalog (unlike before this function threaded roster
  // data into parseCatalog itself) - findAmbiguousNickname's player-prop
  // guard (parse-catalog.ts) needs the roster's full names available at
  // parse time, not just afterward for the unresolved-line fallback below.
  // getCachedNflRoster is a plain indexed table read (no live fetch), so
  // fetching it unconditionally here - rather than only when a player-prop
  // line was already known to be unresolved, the old gate - costs one extra
  // always-on Postgres read per import in exchange for the ambiguous-team
  // guard actually working; no separate names-only query is issued, since
  // the full RosterPlayer rows this function already needs for its own
  // roster-fallback pass below carry playerName too.
  const roster = await getCachedNflRoster();
  const rosterFullNames = roster.map((p) => p.playerName);

  // Same feed-derived teams the client's own parse was given (see
  // getImportFeedTeamsAction), so both passes agree on which lines are unresolved.
  const feedTeams = await getImportFeedTeams();

  const { picks, unresolved, unresolvedCapperNames } = parseCatalog(text, knownCapperNames, rosterFullNames, feedTeams);
  if (unresolved.length === 0) return { recovered: [], stillUnresolved: [], reasons: {} };

  // Always fetched once there is anything unresolved: team lines match against
  // it, and any player-prop line may turn out to be a shared surname, which
  // only a complete slate is allowed to settle (see gatherLiveTeamNames).
  const { teams: liveTeams, completeSports } = await gatherLiveTeamNames();

  // The NHL roster is read only when some unresolved line is an NHL prop, so a
  // paste with none pays no extra query. A failed read (table not migrated yet,
  // transient DB error) degrades to "NHL lines stay unresolved" - it must never
  // break NFL recovery.
  // The MLB roster is read only when some unresolved line is an MLB prop, with the same degrade-to-
  // unresolved failure policy. The NHL roster is ALSO read then: it is the cross-sport guard for "hits".
  const hasMlbProp = unresolved.some(
    (line) => parsePlayerProp(line) === null && parseNhlPlayerProp(line) === null && parseSupportedMlbProp(line) !== null
  );
  let mlbRoster: Awaited<ReturnType<typeof getCachedMlbRoster>> = [];
  if (hasMlbProp) {
    try {
      mlbRoster = await getCachedMlbRoster();
    } catch (err) {
      console.error("recoverUnresolvedPicksAction: MLB roster read failed", err);
    }
  }
  let nhlRoster: Awaited<ReturnType<typeof getCachedNhlRoster>> = [];
  if (hasMlbProp || unresolved.some((line) => parsePlayerProp(line) === null && parseNhlPlayerProp(line) !== null)) {
    try {
      nhlRoster = await getCachedNhlRoster();
    } catch (err) {
      console.error("recoverUnresolvedPicksAction: NHL roster read failed", err);
    }
  }

  return recoverUnresolvedLines(unresolved, unresolvedCapperNames, liveTeams, roster, picks, nhlRoster, mlbRoster, completeSports);
}
