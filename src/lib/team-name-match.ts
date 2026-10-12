// Cross-source team-name matching.
//
// A score / schedule source (ESPN's scoreboard, the MLB Stats API) and the
// odds source (The Odds API) spell a handful of teams differently:
//
//   - accented vs plain:  "Montréal Canadiens"  vs  "Montreal Canadiens"
//   - "St." vs "St":       "St. Louis Blues"     vs  "St Louis Blues"
//
// The Odds API is not even internally consistent about the second one - its
// MLB feed writes "St. Louis Cardinals" with the period, its NHL feed writes
// "St Louis Blues" without. Confirmed live for NHL during the NHL grading
// build; MLB names happen to agree today, so this only bites once a sport
// with a divergent name (NHL: Canadiens, Blues) is graded.
//
// Every join between the two sources compares full team names with `===`
// (deriveLedgerFields, resolveOddsGame, matchScoreToGame, team-tendencies'
// findOddsGameForResult / moneylinePrice / spreadPoint). For a divergent
// team that silently never matches: the finished game gets no
// favTeam/totalLine ledger fields and no team-tendency contribution, and any
// downstream check that assumes `GameResult.favTeam` is string-equal to
// `homeTeam` or `awayTeam` (e.g. decay-delta-backtest) misclassifies fav vs
// dog. This normalizes both sides of such a comparison for matching only -
// the stored / displayed name is always left exactly as the source gave it.
//
// Deliberately NOT fuzzy-match.ts's normalizeName: that strips every
// non-alphanumeric character, which deletes an accented letter entirely
// ("Montréal" -> "montral") rather than folding it to its base letter, so it
// still wouldn't match "Montreal". Diacritics must fold here, not vanish.

export function normalizeTeamName(name: string): string {
  return name
    .normalize("NFD")
    // strip the combining diacritical marks NFD just split off (U+0300-U+036F)
    .replace(/\p{M}/gu, "")
    .replace(/\./g, "") // "St." -> "St"
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Names the folding above cannot reconcile: the two sources use genuinely
// different words for the same team ("App State" vs "Appalachian State"), or
// differ by a character normalizeTeamName deliberately keeps (an apostrophe).
// One table, keyed by The Odds API sport key, each row
// [score-feed spelling, Odds API spelling]. Every spelling here was read off
// the real feeds on 2026-10-12 (ESPN's team list and scoreboards; The Odds
// API's /participants list), not written from memory.
//
// Scoped per league on purpose: a row only ever applies when the caller says
// which league it is comparing within, so an alias can never join teams across
// sports. And each row is a whole-name pair, never a prefix or a nickname:
// "Louisiana Ragin' Cajuns" aliases to "Louisiana Ragin Cajuns" and to nothing
// else, so it cannot match "Louisiana Tech Bulldogs" or "UL Monroe Warhawks".
//
// Montréal/Montreal and "St Louis"/"St. Louis" (NHL) are NOT here - the
// folding above already reconciles them, re-verified against the same feeds.
export const CROSS_SOURCE_TEAM_ALIASES: Record<string, readonly (readonly [scoreFeed: string, oddsApi: string])[]> = {
  americanfootball_ncaaf: [
    ["Sam Houston Bearkats", "Sam Houston State Bearkats"],
    ["App State Mountaineers", "Appalachian State Mountaineers"],
    ["Massachusetts Minutemen", "UMass Minutemen"],
    ["Louisiana Ragin' Cajuns", "Louisiana Ragin Cajuns"],
    ["Southern Miss Golden Eagles", "Southern Mississippi Golden Eagles"],
    ["Hawai'i Rainbow Warriors", "Hawaii Rainbow Warriors"],
  ],
  basketball_nba: [["LA Clippers", "Los Angeles Clippers"]],
};

// sportKey -> normalized spelling -> the normalized Odds API spelling it stands for.
const ALIAS_LOOKUP: Record<string, Map<string, string>> = Object.fromEntries(
  Object.entries(CROSS_SOURCE_TEAM_ALIASES).map(([sportKey, rows]) => [
    sportKey,
    new Map(rows.map(([scoreFeed, oddsApi]) => [normalizeTeamName(scoreFeed), normalizeTeamName(oddsApi)])),
  ])
);

// Whether two team names refer to the same team, tolerating the cross-source
// spelling differences documented above. For names that already agree
// exactly (the overwhelming majority) this is identical to `a === b`.
//
// sportKey (The Odds API key, e.g. "americanfootball_ncaaf") turns on that
// league's alias rows. Without it only the folding applies - the behaviour
// every caller had before the alias table existed.
export function teamNamesMatch(a: string, b: string, sportKey?: string): boolean {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (na === nb) return true;
  const aliases = sportKey ? ALIAS_LOOKUP[sportKey] : undefined;
  if (!aliases) return false;
  return (aliases.get(na) ?? na) === (aliases.get(nb) ?? nb);
}
