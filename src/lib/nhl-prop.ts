// NHL player-prop text parsing - the NHL twin of bet-line.ts's NFL
// parsePlayerProp, kept in its own pure module so the NFL parser (and every
// NFL test that pins it) is untouched. bet-line.ts re-exports the combined
// parseAnyPlayerProp, which tries the NFL parser FIRST and only then this one.
//
// Markets (mirror the NHL values of schema.prisma's PropMarket enum):
//   ANYTIME_GOAL   yes/no ("anytime goal scorer", "to score a goal", "1+ goals")
//   FIRST_GOAL     yes only ("first goal scorer")
//   SHOTS_ON_GOAL  over/under or "N+" ("2+ shots on goal")
//   POINTS         over/under or "N+" (goals + assists)
//   ASSISTS        over/under or "N+"
//   SAVES          over/under or "N+" (goalie)
//
// POINTS/ASSISTS are also basketball vocabulary, so on their own they say
// nothing about the sport: callers must have independent NHL evidence (an
// explicit "NHL" code, or a unique hit in the cached NHL roster - see
// player-roster-fallback.ts) before treating one as an NHL pick. As a
// second guard, a line above NHL_MAX_POINTS_LINE / NHL_MAX_ASSISTS_LINE is
// never read as an NHL market ("Johnson over 24.5 points" is not hockey).
// shots-on-goal / goal-scorer / saves are NHL-only vocabulary.

export type NhlPropMarket = "ANYTIME_GOAL" | "FIRST_GOAL" | "SHOTS_ON_GOAL" | "POINTS" | "ASSISTS" | "SAVES";

export const NHL_PROP_MARKETS: readonly NhlPropMarket[] = [
  "ANYTIME_GOAL",
  "FIRST_GOAL",
  "SHOTS_ON_GOAL",
  "POINTS",
  "ASSISTS",
  "SAVES",
];

export function isNhlPropMarket(m: string | null | undefined): m is NhlPropMarket {
  return !!m && (NHL_PROP_MARKETS as readonly string[]).includes(m);
}

// Markets whose vocabulary basketball shares - see header.
export function isSportAmbiguousNhlMarket(m: NhlPropMarket): boolean {
  return m === "POINTS" || m === "ASSISTS";
}

export const NHL_MAX_POINTS_LINE = 3.5;
export const NHL_MAX_ASSISTS_LINE = 2.5;

const NUM = String.raw`\d+(?:\.\d+)?`;

// Period/situation-scoped variants ("PP points", "1st period shots on goal")
// are different markets we don't grade - never read as the plain market.
const SCOPED_VARIANT =
  /\b(?:power\s*play|pp|shorthanded|sh|1st|2nd|3rd|first|second|third|p[123])\s+(?:period\s+)?(?:points?|assists?|shots?\s+on\s+goal|sogs?|saves?)\b|\b(?:1st|2nd|3rd)\s+period\b/i;

const FIRST_GOAL_RE = /\b(?:(?:first|1st)\s+goal\s*-?\s*scorer|to\s+score\s+(?:the\s+)?(?:first|1st)\s+goal|(?:first|1st)\s+goal)\b/i;
const ANYTIME_GOAL_RE =
  /\b(?:(?:anytime|any\s*time|atg)\s+goal\s*-?\s*scorer|(?:anytime|any\s*time|atg)\s+goal|(?:anytime|any\s*time)\s+scorer|goal\s*-?\s*scorer|to\s+score\s+a\s+goal)\b/i;
// Capper abbreviations. Recognized only with abbreviations enabled (the default);
// looksLikePick turns them off so a capper header like "Sharp AGS" is never
// mistaken for a pick.
const ANYTIME_ABBREV_RE = /\b(?:atgs?|ags)\b/i;
const FIRST_ABBREV_RE = /\bfgs\b/i;
// The lookbehind keeps "no" inside another word from counting; "No Goal
// Scorer", "Goal Scorer - No", "not to score".
const ANYTIME_NO_RE = /\bno\s+(?:anytime\s+)?goal\s*-?\s*scorer\b|\bgoal\s*-?\s*scorer\s*[:-]?\s*no\b|\bnot\s+to\s+score\b/i;
const SHOTS_RE = /\b(?:shots?\s+on\s+goal|sogs?)\b/i;
// Bare "shots" ("Matthews over 4.5 shots") - only with an over/under line, and
// sport-ambiguous like points/assists (soccer has shots too): see detectUnsupportedProp.
const SHOTS_BARE_RE = /\bshots\b/i;
const SHOTS_STRIP_RE = /\b(?:shots?\s+on\s+goal|sogs?|shots)\b/i;
const SAVES_RE = /\b(?:goalie\s+)?saves\b/i;
const POINTS_RE = /\b(?:points?|pts)\b/i;
const ASSISTS_RE = /\b(?:assists?|ast)\b/i;

const MARKET_STRIP: Record<NhlPropMarket, RegExp> = {
  FIRST_GOAL: FIRST_GOAL_RE,
  ANYTIME_GOAL: ANYTIME_GOAL_RE,
  SHOTS_ON_GOAL: SHOTS_STRIP_RE,
  SAVES: SAVES_RE,
  POINTS: POINTS_RE,
  ASSISTS: ASSISTS_RE,
};

// "Over N" / "Under N" / o|u shorthand, same shapes parsePlayerPropLine reads.
function hasOverUnderLine(text: string): { line: number } | null {
  const m =
    text.match(new RegExp(String.raw`\b(?:over|under)\s+(${NUM})\b`, "i")) ??
    text.match(new RegExp(String.raw`\b[ou]\s*(${NUM})\b`, "i"));
  return m ? { line: parseFloat(m[1]) } : null;
}

function classify(text: string, abbreviations: boolean): NhlPropMarket | null {
  if (SCOPED_VARIANT.test(text)) return null;
  // Order matters: FIRST_GOAL before ANYTIME_GOAL ("first goal scorer" also
  // contains "goal scorer"); the yes/no goal markets before the line markets.
  if (FIRST_GOAL_RE.test(text) || (abbreviations && FIRST_ABBREV_RE.test(text))) return "FIRST_GOAL";
  if (ANYTIME_GOAL_RE.test(text) || (abbreviations && ANYTIME_ABBREV_RE.test(text))) return "ANYTIME_GOAL";
  if (SHOTS_RE.test(text)) return "SHOTS_ON_GOAL";
  // SAVES/POINTS/ASSISTS need an actual line ("Saves Sam" is a capper name, not
  // a pick); POINTS/ASSISTS also need a plausible hockey one.
  const line = hasOverUnderLine(text);
  if (!line) return null;
  if (SAVES_RE.test(text)) return "SAVES";
  if (SHOTS_BARE_RE.test(text)) return "SHOTS_ON_GOAL";
  if (ASSISTS_RE.test(text)) return line.line <= NHL_MAX_ASSISTS_LINE ? "ASSISTS" : null;
  if (POINTS_RE.test(text)) return line.line <= NHL_MAX_POINTS_LINE ? "POINTS" : null;
  return null;
}

// N+ thresholds: rewrites "2+ shots on goal" -> "Over 1.5 shots on goal" and
// "1+ goals"/"1+ goal" -> "Anytime Goal" for NHL markets ONLY. "2+ goals" (a
// multi-goal market we don't grade) and any N+ before a non-NHL stat word are
// returned untouched. Called from bet-line.ts's normalizeNPlusPlayerProp AFTER
// its NFL rewrite found nothing to do, so NFL output is byte-identical.
export function normalizeNhlNPlus(text: string): string {
  if (/\b(?:over|under)\s+\d/i.test(text)) return text;
  // "1+ goals" IS the anytime goal-scorer market; consumed whole so no stray
  // "goals" is left behind in the player name.
  text = text.replace(/(?<![\w.-])1\+\s*goals?\b/gi, "Anytime Goal");
  return text.replace(/(?<![\w.-])(\d+)\+\s*(?=\S)/g, (whole, digits: string, offset: number) => {
    const n = parseInt(digits, 10);
    if (n < 1) return whole;
    const after = text.slice(offset + whole.length);
    if (/^goals?\b/i.test(after)) return whole; // 2+ goals: multi-goal market, not graded
    const isLineMarket = [SHOTS_STRIP_RE, SAVES_RE, POINTS_RE, ASSISTS_RE].some((re) =>
      new RegExp("^(?:" + re.source + ")", "i").test(after)
    );
    if (!isLineMarket) return whole;
    // The cap also applies to the threshold form: "25+ points" is not hockey.
    if (POINTS_RE.test(after.slice(0, 8)) && n - 0.5 > NHL_MAX_POINTS_LINE) return whole;
    if (ASSISTS_RE.test(after.slice(0, 8)) && n - 0.5 > NHL_MAX_ASSISTS_LINE) return whole;
    return "Over " + (n - 0.5) + " ";
  });
}

// yes/no side of an ANYTIME_GOAL pick. YES unless the text says otherwise.
export function nhlAnytimeGoalSide(text: string): "YES" | "NO" {
  return ANYTIME_NO_RE.test(text) ? "NO" : "YES";
}

export function parseNhlPlayerProp(
  text: string,
  opts: { abbreviations?: boolean } = {}
): { playerName: string; propMarket: NhlPropMarket } | null {
  const abbreviations = opts.abbreviations !== false;
  const normalized = normalizeNhlNPlus(text);
  const propMarket = classify(normalized, abbreviations);
  if (!propMarket) return null;

  const playerName = normalized
    .replace(/\([^)]*\)/g, " ")
    .replace(ANYTIME_NO_RE, " ")
    .replace(MARKET_STRIP[propMarket], " ")
    .replace(abbreviations ? /\b(?:fgs|atgs?|ags)\b/gi : /$^/, " ")
    .replace(/\b(?:goalie|goaltender|anytime|any\s*time|nhl)\b/gi, " ")
    .replace(/\b(over|under)\b/gi, " ")
    .replace(/\b[ou]\s*(?=\d)/gi, " ")
    .replace(/[+-]?\d+(?:\.\d+)?\+?/g, " ")
    .replace(/\b(?:yes|no)\b/gi, " ")
    .replace(/[+\-:]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!playerName) return null;
  return { playerName, propMarket };
}
