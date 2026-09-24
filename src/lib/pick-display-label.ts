// Canonical, human-readable pick label - e.g. "cubs ml" (the capper's raw
// betDetail text) becomes "Cubs Moneyline" for display, while betDetail
// itself is never touched anywhere in this file or by any caller of it.
//
// Pure: no DB, no network, no UI state. Takes exactly the resolved-field
// shape already sitting in scope at bulk-picks.ts's resolveGameAndOdds call
// site (homeTeam/awayTeam/pickedSide/line/playerName/propMarket/sportName/
// betDetail) - this file does not itself resolve anything, it only formats
// what's already been resolved. See the discovery report ("Clean pick
// display labels for new imports") for the full survey of what's actually
// available at that call site and why manual entries and unresolved/
// ambiguous picks can never reach a valid label.
//
// Returns null - never a partial or guessed label - whenever any condition
// below isn't met for the given bet type. Every caller is expected to fall
// back to its own existing betDetail/betTypeLabel display, exactly as today.
import { shortTeamName } from "@/lib/pick-team-group";
import { stripTeamNamesFromPlayerName } from "@/lib/parse-catalog";
import { totalSideFromText, parsePlayerPropLine, nrfiSide, parseTouchdownProp } from "@/lib/bet-line";

export type PickDisplayLabelInput = {
  betType: string; // Prisma BetType enum value, typed loosely like betTypeLabel/formatPickLabel already are
  // Whether resolveGameAndOdds actually matched a real scheduled game -
  // false means homeTeam/awayTeam are placeholder values (see that
  // function's own comment in bulk-picks.ts) and must never be used here.
  matched: boolean;
  homeTeam: string;
  awayTeam: string;
  pickedSide: "HOME" | "AWAY" | null;
  line: number | null;
  playerName: string | null;
  propMarket: string | null; // Prisma PropMarket enum value
  sportName: string;
  betDetail: string | null;
};

// One phrase per PropMarket enum value (schema.prisma) - the exact set of 7
// confirmed there, not guessed. TD is deliberately absent: a TD-market pick
// is usually the anytime-scorer market this app actually grades (see
// resolveTouchdownProp, grading.ts - "did this player score at least once"),
// so TD gets its own "{player} Anytime TD" format below instead of slotting
// into the Over/Under/line template the other six markets share. But not
// every TD pick IS anytime-scorer text - "2+ TDs", "Over 1.5 TDs" etc name a
// count above one, a different bet than anytime TD - so that format only
// applies when the betDetail text doesn't say otherwise (see the TD case
// below).
const PROP_MARKET_PHRASES: Record<string, string> = {
  PASS_YDS: "Pass Yds",
  RUSH_YDS: "Rush Yds",
  REC_YDS: "Rec Yds",
  RECEPTIONS: "Receptions",
  RUSH_REC_YDS: "Rush+Rec Yds",
  PASS_RUSH_YDS: "Pass+Rush Yds",
};

// Same spread-suffix sign convention formatPickLabel (bet-line.ts) already
// uses: a positive line gets an explicit "+" (line's own sign covers negative
// and zero shows unsigned "0").
function signedLine(line: number): string {
  return line > 0 ? `+${line}` : `${line}`;
}

function pickedTeam(input: Pick<PickDisplayLabelInput, "pickedSide" | "homeTeam" | "awayTeam">): string | null {
  if (input.pickedSide === "HOME") return input.homeTeam;
  if (input.pickedSide === "AWAY") return input.awayTeam;
  return null;
}

export function buildPickDisplayLabel(input: PickDisplayLabelInput): string | null {
  if (!input.matched) return null;

  switch (input.betType) {
    case "MONEYLINE": {
      const team = pickedTeam(input);
      if (!team) return null;
      return `${shortTeamName(team, input.sportName)} Moneyline`;
    }

    case "SPREAD": {
      const team = pickedTeam(input);
      if (!team || input.line === null) return null;
      return `${shortTeamName(team, input.sportName)} ${signedLine(input.line)}`;
    }

    case "TEAM_TOTAL": {
      const team = pickedTeam(input);
      if (!team || input.line === null) return null;
      const side = totalSideFromText(input.betDetail);
      if (!side) return null;
      const sideWord = side === "OVER" ? "Over" : "Under";
      return `${shortTeamName(team, input.sportName)} ${sideWord} ${input.line}`;
    }

    case "TOTAL": {
      if (input.line === null) return null;
      const side = totalSideFromText(input.betDetail);
      if (!side) return null;
      const sideWord = side === "OVER" ? "Over" : "Under";
      const away = shortTeamName(input.awayTeam, input.sportName);
      const home = shortTeamName(input.homeTeam, input.sportName);
      return `${away} @ ${home} ${sideWord} ${input.line}`;
    }

    case "PLAYER_PROP": {
      if (!input.playerName || !input.propMarket) return null;
      const cleanedName = stripTeamNamesFromPlayerName(input.playerName, [input.homeTeam, input.awayTeam], input.sportName);
      if (!cleanedName) return null;

      if (input.propMarket === "TD") {
        // Reuses the same two parsers grading already reads TD betDetail
        // with (resolveTouchdownProp, grading.ts): parseTouchdownProp's
        // `unsupported` flag catches explicit multi-TD text ("2+ TDs"), and
        // parsePlayerPropLine catches an Over/Under-shaped count ("Over 1.5
        // TDs") - either signals a bet that isn't the plain anytime-scorer
        // market, so the label falls back to raw betDetail rather than
        // mislabeling it "Anytime TD".
        const detail = input.betDetail ?? "";
        if (parseTouchdownProp(detail)?.unsupported) return null;
        if (parsePlayerPropLine(detail)) return null;
        return `${cleanedName} Anytime TD`;
      }

      const phrase = PROP_MARKET_PHRASES[input.propMarket];
      if (!phrase) return null;

      // Pick.line is never populated for PLAYER_PROP (extractLine has no
      // PLAYER_PROP branch - see bet-line.ts) - the real line only ever lives
      // in betDetail's free text, so it's re-derived here the exact same way
      // grading does for player props (grading.ts:841's
      // `parsePlayerPropLine(pick.betDetail ?? "")`), not from input.line.
      const lineInfo = parsePlayerPropLine(input.betDetail ?? "");
      if (!lineInfo) return null;

      const sideWord = lineInfo.direction === "OVER" ? "Over" : "Under";
      return `${cleanedName} ${sideWord} ${lineInfo.line} ${phrase}`;
    }

    case "NRFI": {
      const side = nrfiSide(input.betDetail);
      if (!side) return null;
      const sideWord = side === "NO_RUN" ? "NRFI" : "YRFI";
      const away = shortTeamName(input.awayTeam, input.sportName);
      const home = shortTeamName(input.homeTeam, input.sportName);
      return `${away} @ ${home} ${sideWord}`;
    }

    default:
      return null;
  }
}
