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

// Whether two team names refer to the same team, tolerating the cross-source
// spelling differences documented above. For names that already agree
// exactly (the overwhelming majority) this is identical to `a === b`.
export function teamNamesMatch(a: string, b: string): boolean {
  return normalizeTeamName(a) === normalizeTeamName(b);
}
