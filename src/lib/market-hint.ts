// Normalized keyword bucket for a catalog line, used to group the import
// skipped-line log ("what markets do cappers post that we don't support?").
// Computed once at write time so the report never re-parses text. Order
// matters: the first matching bucket wins, so more specific phrases
// ("first 5", "shots on goal") sit ahead of the generic ones they contain.
//
// Also doubles as the "known market vocabulary" test for parseCatalog's
// droppedAsHeaders detection (see looksPickLikeHeader below).
const BUCKETS: { hint: string; pattern: RegExp }[] = [
  { hint: "nrfi", pattern: /\b(?:nrfi|yrfi)\b/i },
  { hint: "f5", pattern: /\bf5\b|\bfirst\s*(?:5|five)\b|\b1st\s*5\b/i },
  { hint: "series", pattern: /\bseries\b/i },
  { hint: "anytime scorer", pattern: /\banytime\b|\b(?:goal|td|touchdown)\s*scorer\b|\bato?\s*td\b/i },
  { hint: "shots on goal", pattern: /\bshots?\s*on\s*goal\b|\bsog\b/i },
  { hint: "strikeouts", pattern: /\bstrike\s*outs?\b|\bstrikeouts?\b|\bks\b/i },
  { hint: "outs", pattern: /\bouts?\s*(?:recorded)?\b|\bpitching\s*outs\b/i },
  { hint: "total bases", pattern: /\btotal\s*bases\b|\btb\b/i },
  { hint: "saves", pattern: /\bsaves?\b/i },
  { hint: "home runs", pattern: /\bhome\s*runs?\b|\bhrs?\b/i },
  { hint: "hits", pattern: /\bhits?\b/i },
  { hint: "rbi", pattern: /\brbis?\b/i },
  { hint: "passing yards", pattern: /\bpass(?:ing)?\s*yards?\b|\bpass\s*yds\b/i },
  { hint: "rushing yards", pattern: /\brush(?:ing)?\s*yards?\b|\brush\s*yds\b/i },
  { hint: "receiving yards", pattern: /\brec(?:eiving)?\s*yards?\b|\brec\s*yds\b/i },
  { hint: "receptions", pattern: /\breceptions?\b/i },
  { hint: "threes", pattern: /\b(?:3\s*pt|3-pt|three)s?\s*(?:pointers?|made)?\b|\bthrees\b/i },
  { hint: "rebounds", pattern: /\brebounds?\b|\breb\b/i },
  { hint: "assists", pattern: /\bassists?\b|\bast\b/i },
  { hint: "goals", pattern: /\bgoals?\b/i },
  { hint: "points", pattern: /\bpoints?\b|\bpts\b/i },
  { hint: "first half", pattern: /\b1h\b|\bfirst\s*half\b|\b1st\s*half\b/i },
  { hint: "parlay", pattern: /\bparlay\b|\bteaser\b/i },
  { hint: "over/under", pattern: /\bover\b|\bunder\b|\b[ou]\s*\d/i },
];

export function computeMarketHint(text: string): string | null {
  for (const { hint, pattern } of BUCKETS) {
    if (pattern.test(text)) return hint;
  }
  return null;
}

// True when a line that parseCatalog was about to read as a capper name
// nonetheless looks like a pick: a digit, a "+", or known market
// vocabulary. Deliberately loose - a false positive ("KRASH 12-2") only
// costs a log row, never a parse change.
export function looksPickLikeHeader(text: string): boolean {
  return /[\d+]/.test(text) || computeMarketHint(text) !== null;
}
