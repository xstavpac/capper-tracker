// NBA player-prop text parsing - the NBA twin of nhl-prop.ts, kept in its own
// pure module (no imports) so the NFL / NHL / MLB parsers are untouched.
//
// Markets (mirror the NBA values of schema.prisma's PropMarket enum):
//   POINTS                    points / pts               - SHARED with the NHL
//   ASSISTS                   assists / ast / asts       - SHARED with the NHL
//   REBOUNDS                  rebounds / rebs / reb / boards
//   THREES_MADE               threes / 3s / 3pm / 3pt / 3-pointers / three pointers
//   STEALS                    steals / stl
//   BLOCKS                    blocks / blk
//   POINTS_REBOUNDS_ASSISTS   PRA / pts+reb+ast / points rebounds assists
//   POINTS_REBOUNDS           P+R / PR / pts+reb / points and rebounds
//   POINTS_ASSISTS            P+A / PA / pts+ast / points and assists
//   REBOUNDS_ASSISTS          R+A / RA / reb+ast / rebounds and assists
//   DOUBLE_DOUBLE             double-double / double double / DD (yes/no, no line)
//
// Every market but DOUBLE_DOUBLE needs a line: "over 24.5", "o24.5", "o 24.5",
// "under ...", or the threshold form "25+ points" (= over 24.5).
//
// This parser is SPORT-BLIND, like the NHL one: "points" and "assists" are
// hockey words too, and every word here is WNBA / college vocabulary as well.
// A caller must have NBA evidence before treating a result as an NBA pick - an
// explicit "NBA" code, an NBA team on the line, or a hit in the cached NBA
// roster (see recover-unresolved-lines.ts). POINTS / ASSISTS are one enum value
// for both leagues: isNbaPropMarket("POINTS") and isNhlPropMarket("POINTS") are
// both true, so anything that reads either value must know the sport too.
//
// Markets this app has no grader for (triple-double, first basket, a quarter-
// or half-scoped stat, turnovers, steals+blocks, ...) are still recognized as
// NBA props - with `unsupported` set and no market - so they are never read as
// a moneyline or a total, and never graded as the nearest supported market.

export type NbaPropMarket =
  | "POINTS"
  | "ASSISTS"
  | "REBOUNDS"
  | "THREES_MADE"
  | "STEALS"
  | "BLOCKS"
  | "POINTS_REBOUNDS_ASSISTS"
  | "POINTS_REBOUNDS"
  | "POINTS_ASSISTS"
  | "REBOUNDS_ASSISTS"
  | "DOUBLE_DOUBLE";

export const NBA_PROP_MARKETS: readonly NbaPropMarket[] = [
  "POINTS",
  "ASSISTS",
  "REBOUNDS",
  "THREES_MADE",
  "STEALS",
  "BLOCKS",
  "POINTS_REBOUNDS_ASSISTS",
  "POINTS_REBOUNDS",
  "POINTS_ASSISTS",
  "REBOUNDS_ASSISTS",
  "DOUBLE_DOUBLE",
];

// The values no other sport has. A pick carrying one of these is an NBA prop
// whatever else is known about it; POINTS / ASSISTS need the sport.
export const NBA_ONLY_PROP_MARKETS: readonly NbaPropMarket[] = NBA_PROP_MARKETS.filter((m) => m !== "POINTS" && m !== "ASSISTS");

export function isNbaPropMarket(m: string | null | undefined): m is NbaPropMarket {
  return !!m && (NBA_PROP_MARKETS as readonly string[]).includes(m);
}

// The two markets whose vocabulary (and enum value) the NHL shares.
export function isNhlSharedNbaMarket(m: NbaPropMarket): boolean {
  return m === "POINTS" || m === "ASSISTS";
}

const NUM = String.raw`\d+(?:\.\d+)?`;

const P = String.raw`(?:points?|pts)`;
const R = String.raw`(?:rebounds?|rebs?|boards)`;
const A = String.raw`(?:assists?|asts?)`;
const S = String.raw`(?:steals?|stls?)`;
const B = String.raw`(?:blocks?|blks?)`;
// Between two stat words of a combined market: "+", "&", "/", ",", "and", or
// just a space ("points rebounds assists").
const JOIN = String.raw`(?:\s*(?:\+|&|/|,|\band\b)\s*|\s+)`;
// Between two single-LETTER stats only an explicit sign counts ("p+r", "r/a").
const SIGN = String.raw`\s*[+/&]\s*`;

const word = (body: string) => new RegExp(String.raw`(?<![\w+])(?:${body})(?![\w+])`, "i");

const PRA_RE = word(String.raw`pra|p${SIGN}r${SIGN}a|${P}${JOIN}${R}${JOIN}${A}`);
const PR_RE = word(String.raw`p${SIGN}r|${P}${JOIN}${R}`);
const PA_RE = word(String.raw`p${SIGN}a|${P}${JOIN}${A}`);
const RA_RE = word(String.raw`r${SIGN}a|${R}${JOIN}${A}`);
// Bare "PR" / "PA" / "RA" are ordinary letter pairs (Puerto Rico, Pennsylvania),
// so they are a market ONLY flush against the line: "Embiid PR o40.5",
// "Embiid o40.5 PR", "Embiid 41+ PR".
const BARE_COMBO_RE = new RegExp(
  String.raw`\b(pr|pa|ra)\b(?=\s*(?:over|under|[ou])\s*\d)|(?<=\b(?:over|under|[ou])\s*${NUM}\s*)\b(pr|pa|ra)\b`,
  "i"
);
const BARE_COMBO_MARKET: Record<string, NbaPropMarket> = { pr: "POINTS_REBOUNDS", pa: "POINTS_ASSISTS", ra: "REBOUNDS_ASSISTS" };

const THREES_RE = word(String.raw`(?:made\s+)?(?:threes|3s|3pm|3ptm|3-?pts?|3[\s-]?pointers?|three[\s-]?pointers?)(?:\s+made)?`);
const REBOUNDS_RE = word(R);
const ASSISTS_RE = word(A);
const STEALS_RE = word(S);
const BLOCKS_RE = word(B);
const POINTS_RE = word(P);

const DOUBLE_DOUBLE_RE = /\bdouble[\s-]?doubles?\b/i;
// "Jokic DD". Recognized only with abbreviations enabled (the default); a
// caller deciding whether a line LOOKS like a pick turns them off.
// Only as the line's closing word after a name ("Jokic DD", "Jokic DD +150"),
// never leading one ("DD Picks").
const DD_ABBREV_RE = /(?<=\S\s+)dd\b(?=\s*(?:$|[(+\-]|\d))/i;
const DOUBLE_DOUBLE_NO_RE = /\bno\s+double[\s-]?double\b|\bdouble[\s-]?doubles?\s*[:-]?\s*no\b|\bnot\s+to\s+(?:record|get|have|post|notch)\b/i;

// ---- Markets this app does not grade ----
const TRIPLE_DOUBLE_RE = /\btriple[\s-]?doubles?\b/i;
const FIRST_BASKET_RE =
  /\b(?:first|1st)\s+(?:basket|bucket|field\s+goal|fg|points?|scorer)\b|\bto\s+score\s+(?:the\s+)?(?:first|1st)\b|\bfirst\s+to\s+score\b/i;
const SCOPED_RE = /\b(?:1st|2nd|3rd|4th|first|second|third|fourth)\s+(?:quarter|qtr|half)\b|\b[1-4]q\b|\bq[1-4]\b|\b[12]h\b/i;
const STEALS_BLOCKS_RE = word(String.raw`${S}${JOIN}${B}|${B}${JOIN}${S}|stocks|s${SIGN}b`);
// A combined market mixing steals or blocks with another stat ("pts+stl").
const OTHER_COMBO_RE = word(String.raw`(?:${P}|${R}|${A})\s*(?:\+|&|/)\s*(?:${S}|${B})|(?:${S}|${B})\s*(?:\+|&|/)\s*(?:${P}|${R}|${A})`);
const OTHER_STAT_RE = word(
  String.raw`turnovers?|tov|fouls?|field\s+goals?(?:\s+(?:made|attempted))?|fgm|fga|free\s+throws?(?:\s+(?:made|attempted))?|ftm|fta|minutes|fantasy(?:\s+(?:points?|score))?|dunks?|offensive\s+rebounds?|defensive\s+rebounds?`
);

const UNSUPPORTED_REASON = {
  TRIPLE_DOUBLE: "this bet is a triple-double prop, which this app doesn't grade automatically yet - needs manual grading",
  FIRST_BASKET: "this bet is a first-basket prop, which this app doesn't grade automatically yet - needs manual grading",
  SCOPED: "this bet is a quarter- or half-scoped player prop, which this app doesn't grade automatically yet - needs manual grading",
  OTHER: "this NBA prop market isn't one this app grades automatically yet - needs manual grading",
} as const;

// "Over N" / "Under N" / the o|u shorthand, with or without a space.
function hasLine(text: string): boolean {
  return new RegExp(String.raw`\b(?:over|under)\s+${NUM}\b`, "i").test(text) || new RegExp(String.raw`\b[ou]\s*${NUM}\b`, "i").test(text);
}

// Every line market, most specific first: a combined market before its parts,
// threes before points ("3-pointers").
const LINE_MARKETS: [NbaPropMarket, RegExp][] = [
  ["POINTS_REBOUNDS_ASSISTS", PRA_RE],
  ["POINTS_REBOUNDS", PR_RE],
  ["POINTS_ASSISTS", PA_RE],
  ["REBOUNDS_ASSISTS", RA_RE],
  ["THREES_MADE", THREES_RE],
  ["REBOUNDS", REBOUNDS_RE],
  ["ASSISTS", ASSISTS_RE],
  ["STEALS", STEALS_RE],
  ["BLOCKS", BLOCKS_RE],
  ["POINTS", POINTS_RE],
];

type Classified = { market: NbaPropMarket; strip: RegExp } | { unsupported: string; strip: RegExp } | null;

function classify(text: string, abbreviations: boolean): Classified {
  const line = hasLine(text);
  // Unsupported shapes first, so none is read as the supported market its
  // words contain ("triple-double", "1st quarter points", "pts+stl").
  if (TRIPLE_DOUBLE_RE.test(text)) return { unsupported: UNSUPPORTED_REASON.TRIPLE_DOUBLE, strip: TRIPLE_DOUBLE_RE };
  if (FIRST_BASKET_RE.test(text)) return { unsupported: UNSUPPORTED_REASON.FIRST_BASKET, strip: FIRST_BASKET_RE };
  if (line && STEALS_BLOCKS_RE.test(text)) return { unsupported: UNSUPPORTED_REASON.OTHER, strip: STEALS_BLOCKS_RE };
  if (line && OTHER_COMBO_RE.test(text)) return { unsupported: UNSUPPORTED_REASON.OTHER, strip: OTHER_COMBO_RE };
  if (line && OTHER_STAT_RE.test(text)) return { unsupported: UNSUPPORTED_REASON.OTHER, strip: OTHER_STAT_RE };

  if (DOUBLE_DOUBLE_RE.test(text)) return { market: "DOUBLE_DOUBLE", strip: DOUBLE_DOUBLE_RE };
  if (abbreviations && DD_ABBREV_RE.test(text)) return { market: "DOUBLE_DOUBLE", strip: DD_ABBREV_RE };

  if (!line) return null;
  for (const [market, re] of LINE_MARKETS) {
    if (!re.test(text)) continue;
    // A supported stat inside one quarter or half is a different market.
    if (SCOPED_RE.test(text)) return { unsupported: UNSUPPORTED_REASON.SCOPED, strip: re };
    return { market, strip: re };
  }
  const bare = BARE_COMBO_RE.exec(text);
  if (bare) {
    if (SCOPED_RE.test(text)) return { unsupported: UNSUPPORTED_REASON.SCOPED, strip: BARE_COMBO_RE };
    return { market: BARE_COMBO_MARKET[(bare[1] ?? bare[2]).toLowerCase()], strip: BARE_COMBO_RE };
  }
  return null;
}

// The text right after an "N+" that makes it an NBA threshold ("25+ points",
// "3+ 3pm", "40+ PRA", "41+ PR").
const N_PLUS_MARKET_START = new RegExp(
  "^(?:" + [...LINE_MARKETS.map(([, re]) => re.source), String.raw`(?:pr|pa|ra)\b`].join("|") + ")",
  "i"
);

// N+ thresholds: rewrites "25+ points" -> "Over 24.5 points" for NBA line
// markets ONLY. Text that already states its own over/under number, and an
// "N+" before anything else, are returned untouched. Sport-blind: a caller
// applies it only to a line it has already identified as an NBA prop.
export function normalizeNbaNPlus(text: string): string {
  if (/\b(?:over|under)\s+\d/i.test(text)) return text;
  return text.replace(/(?<![\w.-])(\d+)\+\s*(?=\S)/g, (whole, digits: string, offset: number) => {
    const n = parseInt(digits, 10);
    if (n < 1) return whole;
    const after = text.slice(offset + whole.length);
    return N_PLUS_MARKET_START.test(after) ? "Over " + (n - 0.5) + " " : whole;
  });
}

// yes/no side of a DOUBLE_DOUBLE pick. YES unless the text says otherwise.
export function nbaDoubleDoubleSide(text: string): "YES" | "NO" {
  return DOUBLE_DOUBLE_NO_RE.test(text) ? "NO" : "YES";
}

// `opponent`: the team named after "@" / "vs" / "v." / "at" ("Brunson o24.5 pts @ Celtics"),
// taken off the player's name. Only present when the line names one.
export type ParsedNbaProp =
  | { playerName: string; propMarket: NbaPropMarket; unsupported?: undefined; opponent?: string }
  // An NBA prop this app can't grade: no market is assigned.
  | { playerName: string; propMarket: null; unsupported: string; opponent?: string };

// "@ Celtics", "@BOS", "vs Knicks", "vs. Lakers", "v. Lakers", "versus Boston", "at Mavericks" -
// the opponent, closing the player segment once the line and market words are gone.
const OPPONENT_TAIL_RE = /\s+(?:@\s*|(?:vs|v|versus|at)\.?\s+)(\S.*)$/i;

// Every NBA prop shape, supported or not. null when the text is not one.
export function parseNbaProp(text: string, opts: { abbreviations?: boolean } = {}): ParsedNbaProp | null {
  const abbreviations = opts.abbreviations !== false;
  const normalized = normalizeNbaNPlus(text.replace(/\([^)]*\)/g, " "));
  const hit = classify(normalized, abbreviations);
  if (!hit) return null;
  // A yes/no market has no number to anchor it, so the player has to come
  // before the words: "Double Double Picks" names nobody.
  if (!hasLine(normalized) && !/[A-Za-z]/.test(normalized.slice(0, hit.strip.exec(normalized)?.index ?? 0))) return null;

  const playerName = normalized
    .replace(DOUBLE_DOUBLE_NO_RE, " ")
    .replace(hit.strip, " ")
    .replace(SCOPED_RE, " ")
    .replace(/\b(?:to\s+)?(?:record|get|have|post|notch)\s+an?\b/gi, " ")
    .replace(/\b(?:nba|made|total|anytime|any\s*time)\b/gi, " ")
    // A stake written without parentheses ("... -115 2u", "1.5 units").
    .replace(/(?<![\w.])\d+(?:\.\d+)?\s*u(?:nits?)?\b/gi, " ")
    .replace(/\b(over|under)\b/gi, " ")
    .replace(/\b[ou]\s*(?=\d)/gi, " ")
    .replace(/[+-]?\d+(?:\.\d+)?\+?/g, " ")
    .replace(/\b(?:yes|no)\b/gi, " ")
    .replace(/[+\-:,/&]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const opp = OPPONENT_TAIL_RE.exec(playerName);
  const name = opp ? playerName.slice(0, opp.index).trim() : playerName;
  if (!name) return null;
  const opponent = opp ? { opponent: opp[1].trim() } : {};
  return "market" in hit
    ? { playerName: name, propMarket: hit.market, ...opponent }
    : { playerName: name, propMarket: null, unsupported: hit.unsupported, ...opponent };
}

// The supported markets only - the shape the other sports' parsers return, so
// it can sit beside them (bet-line.ts's parseAnyPlayerProp). An unsupported NBA
// prop is null here; use parseNbaProp to tell it from "not an NBA prop".
export function parseNbaPlayerProp(text: string, opts: { abbreviations?: boolean } = {}): { playerName: string; propMarket: NbaPropMarket } | null {
  const prop = parseNbaProp(text, opts);
  return prop && prop.propMarket ? { playerName: prop.playerName, propMarket: prop.propMarket } : null;
}
