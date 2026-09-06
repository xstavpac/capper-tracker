// Conservative last-resort resolver for catalog-import lines the static
// parser (parse-catalog.ts) couldn't place - Variant 1 from the
// team-resolution architecture investigation.
//
// parse-catalog.ts is pure/sync/browser-side and stays that way. This runs
// ONLY server-side, ONLY on the lines parseCatalog already put in its
// `unresolved` list, and it checks them against the REAL team names the app
// already pulls every day (ESPN scoreboard + the Odds API OddsSnapshot for
// each RESOLVABLE_SPORT_KEY). Its whole job is to catch names the hand-typed
// lists miss - an FCS "money game" opponent (VMI, Furman, ...), a conference
// newcomer - without ever inventing one.
//
// Conservative by construction:
//   - a line resolves only when it matches EXACTLY ONE live team. Zero
//     matches leaves it unresolved; two or more (a real collision, or a bare
//     shared mascot) reports `ambiguous` and it stays unresolved.
//   - match keys are strong: the team's full live name, a UNIQUE multi-word
//     (or long single-word) prefix of it, or an acronym derived from a
//     unique prefix - and acronyms only match an ALL-CAPS standalone token,
//     the way cappers actually write them (see looksLikeTeamAbbreviation).
//   - it never matches a bare mascot ("Panthers", "Tigers") - a mascot is
//     not a name prefix, so it's not a key.
//
// No fuzzy string distance anywhere - the live names are authoritative and
// current; the only "derivation" is dropping the mascot and taking initials.

import { normalizeForGrouping, teamPhraseRegex } from "@/lib/parse-catalog";

export type LiveTeam = {
  // The sport LABEL as parse-catalog / LIVE_SPORTS use it ("NCAAF", "NFL", ...).
  sport: string;
  // The team's full display name exactly as the live feed returned it
  // ("VMI Keydets", "Florida International Panthers").
  name: string;
};

export type LineResolution =
  | {
      status: "resolved";
      sport: string;
      // Lowercased full live name - resolveGameForNickname does
      // `homeTeam.toLowerCase().endsWith(nickname)`, and this nickname came
      // from that same feed, so it matches the game exactly.
      nickname: string;
      matchedName: string;
      via: "name" | "prefix" | "acronym";
    }
  | { status: "ambiguous"; matches: { sport: string; name: string }[] }
  | { status: "unresolved" };

type TeamKeys = {
  team: LiveTeam;
  nameKey: string; // normalized full name
  // word-boundary substring keys (full name + unique long/multi-word prefixes)
  phraseKeys: string[];
  // standalone ALL-CAPS token keys, lowercased for comparison
  acronymKeys: Set<string>;
};

const STANDALONE_ACRONYM = /(?<![A-Za-z0-9])[A-Z]{2,5}(?![A-Za-z0-9])/g;

function dedupeLiveTeams(teams: LiveTeam[]): LiveTeam[] {
  const seen = new Set<string>();
  const out: LiveTeam[] = [];
  for (const t of teams) {
    const key = t.sport + "|" + normalizeForGrouping(t.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// How many distinct teams have a normalized name equal to `prefix` or
// starting with `prefix + " "` - a prefix is only a usable key when that
// count is exactly 1 (this team). "florida" is shared by Gators / State /
// Atlantic / International; "florida international" is not.
function prefixTeamCount(prefix: string, allNameKeys: string[]): number {
  let n = 0;
  for (const nameKey of allNameKeys) {
    if (nameKey === prefix || nameKey.startsWith(prefix + " ")) n += 1;
  }
  return n;
}

export function buildTeamKeys(liveTeams: LiveTeam[]): TeamKeys[] {
  const teams = dedupeLiveTeams(liveTeams);
  const allNameKeys = teams.map((t) => normalizeForGrouping(t.name));

  return teams.map((team, i) => {
    const nameKey = allNameKeys[i];
    const words = nameKey.split(" ").filter(Boolean);

    const phraseKeys = new Set<string>([nameKey]);
    const acronymKeys = new Set<string>();

    // Every proper prefix (1 .. words.length-1) that is unique to this team.
    for (let take = 1; take < words.length; take++) {
      const prefix = words.slice(0, take).join(" ");
      if (prefixTeamCount(prefix, allNameKeys) !== 1) continue;

      if (take >= 2) {
        // Multi-word unique prefix ("florida international", "new mexico
        // state"): a phrase key, plus its initials + the implicit trailing
        // "U"(niversity) / "I"(nstitute) - "florida international" -> fiu/fii,
        // "eastern michigan" -> emu/emi.
        phraseKeys.add(prefix);
        const initials = words.slice(0, take).map((w) => w[0]).join("");
        for (const cand of [initials, initials + "u", initials + "i"]) {
          if (cand.length >= 2 && cand.length <= 5) acronymKeys.add(cand);
        }
      } else if (prefix.length >= 4) {
        // A distinctive spelled-out single word ("furman", "wofford",
        // "elon", "navy") - matched as a word.
        phraseKeys.add(prefix);
      } else if (prefix.length >= 2) {
        // A short all-caps name that IS the school's abbreviation ("VMI",
        // "SMU", "UNC") - matched only as an all-caps standalone token, same
        // as a derived acronym.
        acronymKeys.add(prefix);
      }
    }

    return { team, nameKey, phraseKeys: [...phraseKeys], acronymKeys };
  });
}

// Resolve one already-unresolved catalog line against the live team set.
export function resolveLineAgainstLiveTeams(line: string, liveTeams: LiveTeam[]): LineResolution {
  const normalizedLine = normalizeForGrouping(line);
  const upperTokens = new Set((line.match(STANDALONE_ACRONYM) ?? []).map((t) => t.toLowerCase()));

  const keyed = buildTeamKeys(liveTeams);

  // team-dedupe key -> the match and how it was found
  const hits = new Map<string, { team: LiveTeam; via: "name" | "prefix" | "acronym" }>();

  for (const { team, nameKey, phraseKeys, acronymKeys } of keyed) {
    const dedupeKey = team.sport + "|" + nameKey;
    if (hits.has(dedupeKey)) continue;

    let via: "name" | "prefix" | "acronym" | null = null;
    for (const phrase of phraseKeys) {
      if (teamPhraseRegex(phrase).test(normalizedLine)) {
        via = phrase === nameKey ? "name" : "prefix";
        break;
      }
    }
    if (!via) {
      for (const acr of acronymKeys) {
        if (upperTokens.has(acr)) {
          via = "acronym";
          break;
        }
      }
    }
    if (via) hits.set(dedupeKey, { team, via });
  }

  const matched = [...hits.values()];
  if (matched.length === 0) return { status: "unresolved" };
  if (matched.length > 1) {
    return { status: "ambiguous", matches: matched.map((m) => ({ sport: m.team.sport, name: m.team.name })) };
  }

  const { team, via } = matched[0];
  return {
    status: "resolved",
    sport: team.sport,
    nickname: team.name.toLowerCase(),
    matchedName: team.name,
    via,
  };
}

// ---- minimal bet-text extraction ---------------------------------------------
// These lines already failed the full parser; this pulls just enough to make
// a gradeable pick (bet type + a units default). extractLine (bet-line.ts)
// still handles the spread/total number from `description` downstream.

export type BetTextParts = {
  betType: "MONEYLINE" | "SPREAD" | "TOTAL";
  odds: number;
  hasExplicitOdds: boolean;
  totalSide?: "over" | "under";
  units: number;
};

export function parseFallbackBetText(line: string): BetTextParts {
  const lower = line.toLowerCase();

  let totalSide: "over" | "under" | undefined;
  if (/\bover\b|\bo\d/.test(lower)) totalSide = "over";
  else if (/\bunder\b|\bu\d/.test(lower)) totalSide = "under";

  let betType: BetTextParts["betType"];
  if (totalSide) betType = "TOTAL";
  else if (/\bml\b|\bmoney\s*line\b/.test(lower)) betType = "MONEYLINE";
  else betType = "SPREAD"; // an unresolved line that looksLikePick with no over/under/ML is a spread

  // American odds: a signed 3+ digit number, distinct from a spread/total
  // number (1-2 digits, often with .5).
  const oddsMatch = line.match(/(?:^|[\s(])([+-]\d{3,})(?![.\d])/);
  const odds = oddsMatch ? parseInt(oddsMatch[1], 10) : -110;

  const unitsMatch = line.match(/\b(\d+(?:\.\d+)?)\s*u(?:nits?)?\b/i);
  const units = unitsMatch ? parseFloat(unitsMatch[1]) : 1;

  return { betType, odds, hasExplicitOdds: oddsMatch !== null, totalSide, units };
}
