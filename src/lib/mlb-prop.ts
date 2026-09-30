// MLB player-prop text parsing - the MLB twin of nhl-prop.ts / bet-line.ts's NFL
// parsePlayerProp, in its own pure module so the NFL and NHL parsers (and every
// test that pins them) are untouched. bet-line.ts re-exports the combined
// parseAnyPlayerProp, which tries NFL, then NHL, then this one.
//
// Markets (mirror the MLB values of schema.prisma's PropMarket enum), all
// Over/Under or "N+" shaped:
//   STRIKEOUTS     pitcher ("Ks", "strikeouts")
//   OUTS_RECORDED  pitcher ("outs", "outs recorded" - IP x 3)
//   TOTAL_BASES    hitter ("TB", "total bases")
//   HITS           hitter
//   WALKS          hitter ("BB", "walks")
//   RUNS           hitter ("runs", "runs scored")
//   RBIS           hitter ("RBI", "RBIs")
//   HOME_RUNS      hitter ("HR", "home runs", "to hit a home run", "anytime HR")
//
// This parser is SPORT-BLIND and team-blind: "Yankees over 4.5 runs" parses as
// RUNS with playerName "Yankees". Callers that classify raw catalog lines must
// gate it behind independent MLB evidence and a person subject (see
// parse-catalog.ts's parseSupportedMlbProp, which uses the same subject-is-a-person
// logic the unsupported-prop detector already has). Callers that already KNOW the
// line is a PLAYER_PROP pick (grading, display, dedup, filters) can use it directly.
//
// What it deliberately does NOT read as a plain market (returns null):
//   - scoped / different markets: "hits allowed", "walks allowed", "earned runs",
//     "1st inning"/"F5"/"first five" anything, "hits+runs+RBIs" combos,
//     singles/doubles/triples, first/last home run;
//   - batter strikeouts ("batter Ks") - only PITCHER strikeouts are a market here.
//     A bare "K" is ambiguous between the two, so the parser reads it as
//     STRIKEOUTS and position decides downstream (a hitter on a K line is
//     declined by position-aware matching, never graded as a pitcher stat);
//   - a line above MLB_MAX_LINE[market] - a ceiling so basketball/football
//     vocabulary ("over 24.5 points", "over 45.5 runs") can never read as baseball.

export type MlbPropMarket =
  | "STRIKEOUTS"
  | "OUTS_RECORDED"
  | "TOTAL_BASES"
  | "HITS"
  | "WALKS"
  | "RUNS"
  | "RBIS"
  | "HOME_RUNS";

export const MLB_PROP_MARKETS: readonly MlbPropMarket[] = [
  "STRIKEOUTS",
  "OUTS_RECORDED",
  "TOTAL_BASES",
  "HITS",
  "WALKS",
  "RUNS",
  "RBIS",
  "HOME_RUNS",
];

export function isMlbPropMarket(m: string | null | undefined): m is MlbPropMarket {
  return !!m && (MLB_PROP_MARKETS as readonly string[]).includes(m);
}

// Pitcher markets need a P/TWP; every other MLB market is a hitter market.
export function isMlbPitcherMarket(m: MlbPropMarket): boolean {
  return m === "STRIKEOUTS" || m === "OUTS_RECORDED";
}

// Hitter markets that need a plate appearance to have happened: a hitter with PA=0 in a final box
// score did not bat, so the pick PUSHes. Contact markets (hits, total bases, home runs, RBIs) are
// the owner-specified set; WALKS is included because a walk IS a plate appearance - with PA=0 the
// "0 walks" would otherwise grade an Over as a LOSS for a player who never came up. RUNS is NOT
// here: a pinch runner can score with no PA, so runs grade off the recorded value regardless.
export function isMlbPaGatedMarket(m: MlbPropMarket): boolean {
  return m === "HITS" || m === "TOTAL_BASES" || m === "HOME_RUNS" || m === "RBIS" || m === "WALKS";
}

// position is the Stats API abbreviation (P, C, 1B..RF, OF, DH, TWP, and the
// in-game-only PH/PR). Pitcher markets: P or TWP. Hitter markets: anything but P.
export function mlbPositionFitsMarket(position: string, market: MlbPropMarket): boolean {
  return isMlbPitcherMarket(market) ? position === "P" || position === "TWP" : position !== "P";
}

// Highest line a real MLB book posts for each market, with headroom. Above this
// the text is not read as an MLB market at all.
export const MLB_MAX_LINE: Record<MlbPropMarket, number> = {
  STRIKEOUTS: 15.5,
  OUTS_RECORDED: 27.5,
  TOTAL_BASES: 8.5,
  HITS: 4.5,
  WALKS: 3.5,
  RUNS: 3.5,
  RBIS: 5.5,
  HOME_RUNS: 2.5,
};

const NUM = String.raw`\d+(?:\.\d+)?`;

// Stat words. Longer phrases first ("runs batted in" before "runs"); each match
// must end on a word boundary so "hits" never matches inside "hitsville".
const WORD = String.raw`(?:runs\s+batted\s+in|runs\s+scored|home\s?runs?|total\s+bases|strike\s?outs?|outs\s+recorded|bases\s+on\s+balls|rbis?|hrs?|hits?|walks?|runs?|outs?|ks?|tb|bb)`;

const LINE_THEN_WORD = new RegExp(String.raw`(?<![\w.])(?:over|under|o|u)\s*(${NUM})\s*(${WORD})\b`, "i");
const WORD_THEN_LINE = new RegExp(String.raw`\b(${WORD})\s+(?:over|under|o|u)\s*(${NUM})\b`, "i");

// Different markets that share stat words - never read as the plain market.
const SCOPED_VARIANT = new RegExp(
  [
    // pitcher/opponent-side stats
    String.raw`\b(?:hits?|walks?|bb|strike\s?outs?|ks?|runs?|home\s?runs?|hrs?|outs?|bases)\s+allowed\b`,
    String.raw`\bearned\s+runs?\b`,
    String.raw`\b(?:pitcher|pitching)\s+(?:hits?|walks?|runs?|earned|home\s?runs?)\b`,
    // inning / segment scoped
    String.raw`\b(?:1st|first)\s+(?:5|five|inning|innings|3|three|6|six|7|seven)\b`,
    String.raw`\b(?:f5|f3|f7|1h|first\s+half)\b`,
    String.raw`\b(?:1st|first|last|2nd|second)\s+(?:home\s?run|hr)\b`,
    // combo markets
    String.raw`\b(?:hits?|h)\s*\+\s*(?:runs?|r)\b`,
    String.raw`\bh\s*\+\s*r\s*\+\s*rbis?\b`,
    // other hit types
    String.raw`\b(?:singles?|doubles?|triples?)\b`,
    // batter strikeouts are not a market here
    String.raw`\b(?:batter|hitter|batters|hitters)\s+(?:strike\s?outs?|ks?)\b`,
  ].join("|"),
  "i"
);

// "to hit a home run" / "anytime HR" are the yes side of Over 0.5 home runs.
const HR_YES_PHRASE = /\b(?:to\s+hit\s+a\s+(?:home\s?run|hr)|(?:anytime|any\s*time)\s+(?:home\s?run|hr))\b/gi;

function marketOfWord(word: string): MlbPropMarket {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  if (/^(?:total bases|tb)$/.test(w)) return "TOTAL_BASES";
  if (/^(?:strike ?outs?|ks?)$/.test(w)) return "STRIKEOUTS";
  if (/^outs?(?: recorded)?$/.test(w)) return "OUTS_RECORDED";
  if (/^(?:home ?runs?|hrs?)$/.test(w)) return "HOME_RUNS";
  if (/^(?:rbis?|runs batted in)$/.test(w)) return "RBIS";
  if (/^runs?(?: scored)?$/.test(w)) return "RUNS";
  if (/^(?:walks?|bb|bases on balls)$/.test(w)) return "WALKS";
  return "HITS";
}

// N+ thresholds: "2+ hits" -> "Over 1.5 hits", "1+ HR" -> "Over 0.5 HR"; the
// yes-phrases ("to hit a home run", "anytime HR") -> "Over 0.5 Home Runs".
// Applies to MLB stat words only; "2+ hits allowed", "3+ first inning Ks" and any
// N+ before a non-MLB word are returned untouched. Called from bet-line.ts's
// normalizeNPlusPlayerProp AFTER the NFL and NHL rewrites found nothing to do,
// so NFL/NHL output is byte-identical to before MLB existed.
export function normalizeMlbNPlus(text: string): string {
  if (SCOPED_VARIANT.test(text)) return text;
  if (/\b(?:over|under)\s+\d/i.test(text)) return text;
  let out = text.replace(HR_YES_PHRASE, "Over 0.5 Home Runs");
  out = out.replace(/(?<![\w.-])(\d+)\+\s*(?=\S)/g, (whole, digits: string, offset: number) => {
    const n = parseInt(digits, 10);
    if (n < 1) return whole;
    const after = out.slice(offset + whole.length);
    const m = new RegExp("^(" + WORD + ")\\b", "i").exec(after);
    if (!m) return whole;
    if (n - 0.5 > MLB_MAX_LINE[marketOfWord(m[1])]) return whole;
    return "Over " + (n - 0.5) + " ";
  });
  return out;
}

export type ParsedMlbProp = { playerName: string; propMarket: MlbPropMarket; line: number };

export function parseMlbPlayerProp(text: string): ParsedMlbProp | null {
  if (SCOPED_VARIANT.test(text)) return null;
  const normalized = normalizeMlbNPlus(text);
  if (SCOPED_VARIANT.test(normalized)) return null;

  const a = LINE_THEN_WORD.exec(normalized);
  const b = WORD_THEN_LINE.exec(normalized);
  // Earliest match wins when a line carries both shapes.
  const hit = a && b ? (a.index <= b.index ? { word: a[2], line: a[1], m: a } : { word: b[1], line: b[2], m: b }) : a ? { word: a[2], line: a[1], m: a } : b ? { word: b[1], line: b[2], m: b } : null;
  if (!hit) return null;

  const propMarket = marketOfWord(hit.word);
  const line = parseFloat(hit.line);
  if (line > MLB_MAX_LINE[propMarket]) return null;

  // Name = everything outside the matched "over N word" / "word over N" phrase,
  // minus odds, parentheticals and MLB noise words.
  const matched = hit.m[0];
  const playerName = (normalized.slice(0, hit.m.index) + " " + normalized.slice(hit.m.index + matched.length))
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:mlb|pitcher|pitching|hitter|hitting|batter|starter|sp)\b/gi, " ")
    .replace(/\bvs\.?(?=\s)|@/gi, " ") // "Yankees vs Red Sox Schlittler": matchup words are not part of the name
    .replace(/\b(?:over|under)\b/gi, " ")
    .replace(/\b[ou]\s*(?=\d)/gi, " ")
    .replace(/[+-]?\d+(?:\.\d+)?\+?/g, " ")
    .replace(/[+\-:]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!/[a-z]/i.test(playerName)) return null;
  return { playerName, propMarket, line };
}
