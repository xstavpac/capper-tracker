// Hockey 3-way (regulation-time) moneyline: a bet on the result after 60
// minutes, with three outcomes - home, away, or a draw. A game level after
// regulation settles as the draw, so a team that goes on to win in overtime or
// a shootout LOSES its 3-way bet. It is a different market, at a different
// price, from the ordinary 2-way moneyline (which includes overtime and the
// shootout).
//
// Stored as betType MONEYLINE with Pick.period REGULATION, and the outcome in
// Pick.pickedSide (HOME / AWAY / DRAW). Pure text classification lives here so
// the parser, the importer and grading all read the wording the same way.
//
// NHL only: every caller gates on the sport. The words below mean other things
// elsewhere ("reg season", a soccer draw), and nothing outside NHL has a
// regulation score source wired up.

// "3-way" / "3 way" / "3way" / "three way"
const THREE_WAY_RE = /\b(?:3|three)[\s-]*way\b/i;
// "regulation", "regulation time", "in regulation", "reg" / "reg." - but not
// "reg season".
const REGULATION_RE = /\bregulation\b|\breg\b\.?(?!\s*season)/i;
// "60 min" / "60 mins" / "60 minute(s)" / "60-min"
const SIXTY_MIN_RE = /\b60[\s-]*min(?:ute)?s?\b/i;
const DRAW_RE = /\b(?:draw|tie)\b/i;
// Two-way markets that merely mention a draw: "draw no bet" / "tie no bet" /
// "DNB" refunds on a draw, "Oilers or draw" / "double chance" covers two of the
// three outcomes. Neither is the 3-way moneyline.
const NOT_THREE_WAY_RE = /\b(?:draw|tie)\s+no\s+bet\b|\bdnb\b|\bor\s+(?:draw|tie)\b|\b(?:draw|tie)\s+or\b|\bdouble\s+chance\b/i;

// "TEAM": a 3-way bet on one of the two teams. "DRAW": a bet on the draw.
// null: not 3-way wording.
export type ThreeWayWording = "TEAM" | "DRAW";

export function threeWayWording(text: string | null | undefined): ThreeWayWording | null {
  const t = text ?? "";
  if (NOT_THREE_WAY_RE.test(t)) return null;
  if (DRAW_RE.test(t)) return "DRAW";
  if (THREE_WAY_RE.test(t) || REGULATION_RE.test(t) || SIXTY_MIN_RE.test(t)) return "TEAM";
  return null;
}

// The 3-way wording exactly as written ("3-way", "reg", "Draw"), or null. Lets
// parsePickText carry it over from a parenthetical it is about to discard
// ("Oilers ML (regulation)"), the way betScopeToken does for a period.
export function threeWayToken(text: string): string | null {
  if (NOT_THREE_WAY_RE.test(text)) return null;
  for (const re of [DRAW_RE, THREE_WAY_RE, REGULATION_RE, SIXTY_MIN_RE]) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

// The Period a parsed pick should carry: REGULATION for an NHL full-game
// moneyline written as a 3-way bet, otherwise the period it already has.
// Anything else - another sport, a spread or total, a pick already scoped to a
// single period - is returned unchanged.
export function withRegulationPeriod<P extends string>(
  pick: { sportName: string; betType: string; period: P; description: string }
): P | "REGULATION" {
  if (pick.sportName.toUpperCase() !== "NHL" || pick.betType !== "MONEYLINE" || pick.period !== "FULL_GAME") return pick.period;
  return threeWayWording(pick.description) ? "REGULATION" : pick.period;
}

export type ThreeWayOutcome = "WIN" | "LOSS";

// Grades a 3-way pick on the regulation score. `side` is the outcome the pick
// is on; null means a team pick whose side isn't known, which is still a LOSS
// on a level score (both teams lose) and otherwise can't be graded.
export function gradeThreeWay(
  side: "HOME" | "AWAY" | "DRAW" | null,
  regulationHome: number,
  regulationAway: number
): ThreeWayOutcome | null {
  const level = regulationHome === regulationAway;
  if (side === "DRAW") return level ? "WIN" : "LOSS";
  if (level) return "LOSS";
  if (side === "HOME") return regulationHome > regulationAway ? "WIN" : "LOSS";
  if (side === "AWAY") return regulationAway > regulationHome ? "WIN" : "LOSS";
  return null;
}
