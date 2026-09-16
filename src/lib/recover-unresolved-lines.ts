// Pure core of the catalog-import recovery pass (server/actions/recover-
// unresolved-picks.ts is the async, "use server" wrapper that fetches
// liveTeams/roster and calls this). Split out - same reason nfl-prop-odds.ts
// splits resolvePropOdds/resolvePropOddsFromGame and live-team-fallback.ts
// stays a plain module - the "use server" action file transitively imports
// requireUser (@/server/auth), which imports React's cache() and can't be
// loaded outside a Next.js request; a pure file with no such import is the
// only way this logic is unit-testable with fixture data (no network, no DB,
// no auth).
//
// Attribution: unresolvedCapperNames[i] is the capper header active in
// parseCatalog's own pass when unresolved[i] was pushed - the ONLY place
// that association is ever known, since a line in `unresolved` is plain text
// with no capper of its own. Used directly here (by index) instead of being
// re-derived after the fact by scanning already-resolved picks for the
// nearest one before this line's position (the old approach) - that
// reconstruction broke whenever the recovered line was the only, or first,
// pick under its header (a real reported bug: the header matched correctly
// during parseCatalog's own pass, but the resulting recovered pick still
// showed "Unknown", because there was no earlier resolved pick under that
// same header for the reconstruction to find), and it broke similarly for a
// capper whose picks ALL needed recovery - none of their own lines ever
// entered the resolved-picks list either, so every one of them was
// attributed to whichever earlier capper's pick happened to appear first.
import { parsePickText, type ParsedPick } from "@/lib/parse-catalog";
import { resolveLineAgainstLiveTeams, parseFallbackBetText, type LiveTeam } from "@/lib/live-team-fallback";
import { resolvePlayerPropAgainstRoster } from "@/lib/player-roster-fallback";
import { parsePlayerProp } from "@/lib/bet-line";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type RecoverUnresolvedResult = {
  recovered: ParsedPick[];
  stillUnresolved: string[];
};

export function recoverUnresolvedLines(
  unresolved: string[],
  unresolvedCapperNames: string[],
  liveTeams: LiveTeam[],
  roster: RosterPlayer[]
): RecoverUnresolvedResult {
  const recovered: ParsedPick[] = [];
  const stillUnresolved: string[] = [];

  const isPlayerProp = new Set(unresolved.filter((line) => parsePlayerProp(line) !== null));

  for (let i = 0; i < unresolved.length; i++) {
    const line = unresolved[i];
    const capperName = unresolvedCapperNames[i] ?? "Unknown";

    if (isPlayerProp.has(line)) {
      // Only ever narrows a bare-surname collision - never affects the
      // exact/fuzzy full-name tiers. Empty (no live teams fetched this pass,
      // e.g. a catalog made entirely of player-prop lines - see
      // recover-unresolved-picks.ts) just means the surname tier can't break
      // a tie via the slate and falls back to reporting `ambiguous`, same as
      // before this existed - no new network call is made to populate it.
      const relevantNflTeams = liveTeams.filter((t) => t.sport === "NFL").map((t) => t.name);
      const res = resolvePlayerPropAgainstRoster(line, roster, relevantNflTeams);
      if (res.status !== "resolved") {
        // "ambiguous" (2+ distinct players matching) is deliberately treated
        // the same as "unresolved" here, same policy as the team-name
        // fallback below - never guessed.
        stillUnresolved.push(line);
        continue;
      }

      const parsed = parsePickText(line);
      recovered.push({
        capperName,
        sportName: res.sport,
        description: parsed.cleanDescription,
        betType: parsed.betType,
        odds: parsed.odds ?? -110,
        hasExplicitOdds: parsed.odds !== null,
        totalSide: parsed.totalSide,
        units: parsed.units,
        period: parsed.period,
        raw: line,
        teamNicknames: [res.team.toLowerCase()],
      });
      continue;
    }

    const res = resolveLineAgainstLiveTeams(line, liveTeams);
    if (res.status !== "resolved") {
      // "ambiguous" is deliberately treated the same as "unresolved" here -
      // a collision is exactly the case where we must NOT guess.
      stillUnresolved.push(line);
      continue;
    }

    const bet = parseFallbackBetText(line);
    recovered.push({
      capperName,
      sportName: res.sport,
      description: line,
      betType: bet.betType,
      odds: bet.odds,
      hasExplicitOdds: bet.hasExplicitOdds,
      totalSide: bet.totalSide,
      units: bet.units,
      period: "FULL_GAME",
      raw: line,
      teamNicknames: [res.nickname],
    });
  }

  return { recovered, stillUnresolved };
}
