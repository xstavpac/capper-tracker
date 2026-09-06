"use server";

import { requireUser } from "@/server/auth";
import { parseCatalog, type ParsedPick } from "@/lib/parse-catalog";
import {
  resolveLineAgainstLiveTeams,
  parseFallbackBetText,
  type LiveTeam,
} from "@/lib/live-team-fallback";
import { getLiveScoresForSport, getOddsForSport, LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";

// Last-resort resolver for catalog lines the browser-side parser left in its
// `unresolved` list (Variant 1 - see live-team-fallback.ts's header). Runs
// only when there ARE unresolved lines, only server-side, and only against
// the team names the app already caches for its tracked sports. It never
// invents a team: a line resolves only on an EXACT-ONE match, everything
// else stays unresolved.
export type RecoverUnresolvedResult = {
  recovered: ParsedPick[];
  stillUnresolved: string[];
};

// Every distinct team name currently on the live schedule (ESPN) or the
// pregame odds board (Odds API snapshot) for a resolvable sport - the same
// two feeds resolveGameForNickname / lookupGame already match picks against.
async function gatherLiveTeamNames(): Promise<LiveTeam[]> {
  const out: LiveTeam[] = [];
  await Promise.all(
    RESOLVABLE_SPORT_KEYS.map(async (key) => {
      const label = LIVE_SPORTS.find((s) => s.key === key)?.label ?? key;
      const [scores, odds] = await Promise.all([
        getLiveScoresForSport(key).catch(() => []),
        getOddsForSport(key).catch(() => []),
      ]);
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
  return out;
}

// Attribute a recovered line to a capper using parseCatalog's OWN output as
// the source of truth: the capper of the last resolved pick whose text
// appears before this line. No re-implementation of the header heuristics.
function inferCapperFor(line: string, trimmedLines: string[], picks: ParsedPick[]): string {
  const lineIdx = trimmedLines.findIndex((l) => l === line || l.includes(line));
  if (lineIdx === -1) return picks[0]?.capperName ?? "Unknown";

  let capper = picks[0]?.capperName ?? "Unknown";
  for (const pick of picks) {
    const pickIdx = trimmedLines.findIndex((l) => l.includes(pick.raw));
    if (pickIdx !== -1 && pickIdx <= lineIdx) capper = pick.capperName;
  }
  return capper;
}

export async function recoverUnresolvedPicksAction(
  text: string,
  knownCapperNames: string[] = []
): Promise<RecoverUnresolvedResult> {
  await requireUser();

  const { picks, unresolved } = parseCatalog(text, knownCapperNames);
  if (unresolved.length === 0) return { recovered: [], stillUnresolved: [] };

  const liveTeams = await gatherLiveTeamNames();
  const trimmedLines = text.split("\n").map((l) => l.trim());

  const recovered: ParsedPick[] = [];
  const stillUnresolved: string[] = [];

  for (const line of unresolved) {
    const res = resolveLineAgainstLiveTeams(line, liveTeams);
    if (res.status !== "resolved") {
      // "ambiguous" is deliberately treated the same as "unresolved" here -
      // a collision is exactly the case where we must NOT guess.
      stillUnresolved.push(line);
      continue;
    }

    const bet = parseFallbackBetText(line);
    recovered.push({
      capperName: inferCapperFor(line, trimmedLines, picks),
      sportName: res.sport,
      description: line,
      betType: bet.betType,
      odds: bet.odds,
      hasExplicitOdds: bet.hasExplicitOdds,
      totalSide: bet.totalSide,
      units: bet.units,
      isFirstFive: false,
      raw: line,
      teamNicknames: [res.nickname],
    });
  }

  return { recovered, stillUnresolved };
}
