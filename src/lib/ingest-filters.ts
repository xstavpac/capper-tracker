// Filters that apply to the Telegram ingest path only. Manual paste never touches them.
//
//   1. COMBINED_BET: a line that names more than one team or bet joined together ("Bears + Cubs MLP",
//      "Bears / Cubs / Lions", "Bears ML & Cubs ML") is skipped, not imported as one of its legs.
//   2. League allowlist: a pick whose league is not in INGEST_ALLOWED_LEAGUES is skipped (LEAGUE_NOT_ALLOWED).
//
// Pure: no database, no network.
import { isTeamPhrase, resolveAmbiguousPick, type ParsedPick } from "@/lib/parse-catalog";
import type { SkippedLineEntry } from "@/server/data/import-skipped-lines";

// NCAAB is in by default: it has had a game feed (ESPN men's college basketball scores, school list, grading keys)
// since #388/#390. A school that plays both NCAAF and NCAAB stays a question here (both are allowed), settled by the
// ambiguity hierarchy or parked in the review queue; it is only narrowed when the allowlist leaves one of them out.
export const DEFAULT_INGEST_ALLOWED_LEAGUES = "NBA,NFL,NCAAF,NCAAB,NHL,WNBA,MLB";

// Sport NAMES (the Sport table's name column / ParsedPick.sportName), upper-cased.
export function parseAllowedLeagues(raw: string | undefined): Set<string> {
  const source = raw && raw.trim() ? raw : DEFAULT_INGEST_ALLOWED_LEAGUES;
  return new Set(
    source
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

// ---- combined bets ----

// A parlay label anywhere on the line: MLP, parlay, parly, "2-team" / "3 team" / "4-leg".
const PARLAY_TOKEN = /\b(?:mlp|parlays?|parly|parlay's|\d+\s*-?\s*(?:team|leg)s?)\b/i;
// "+" is a separator only when it is NOT a line or odds sign, i.e. not directly followed by a number.
const PLUS_SEPARATOR = /\s*\+(?!\s*[\d.])\s*/;
const SLASH_SEPARATOR = /\s*\/\s*/;
const AMP_SEPARATOR = /\s*&\s*/;
const AND_SEPARATOR = /\s+and\s+/i;
// A totals bet ("Over 44.5", "u8.5", "o 47"). For these, "A/B" is the matchup the total is on, not two bets.
const TOTAL_BET = /\b(?:over|under|o|u)\s*\d/i;

const MAX_PHRASE_WORDS = 4;

// Whether some run of up to four words in the segment is a team (full name, nickname, city + nickname).
function segmentNamesTeam(segment: string): boolean {
  const words = segment
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((w) => /[a-z]/i.test(w));
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= MAX_PHRASE_WORDS && i + n <= words.length; n++) {
      if (isTeamPhrase(words.slice(i, i + n).join(" "))) return true;
    }
  }
  return false;
}

function joinsTwoTeams(line: string, separator: RegExp): boolean {
  const segments = line.split(separator).filter((s) => s.trim().length > 0);
  return segments.length >= 2 && segments.filter(segmentNamesTeam).length >= 2;
}

// True when the line is more than one bet. A capper's header line is never a team pair, so a name like
// "Sharp & Co" passes: separators only count when they join two segments that each name a team.
export function isCombinedBetLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (PARLAY_TOKEN.test(text)) return true;
  if (joinsTwoTeams(text, PLUS_SEPARATOR)) return true;
  if (joinsTwoTeams(text, AMP_SEPARATOR)) return true;
  if (joinsTwoTeams(text, AND_SEPARATOR)) return true;
  if (!TOTAL_BET.test(text) && joinsTwoTeams(text, SLASH_SEPARATOR)) return true;
  return false;
}

// Drops combined-bet lines from a Drop Catalog text (capper line, then that capper's picks, blocks split by blank
// lines) and reports them. The capper for a dropped line is the first line of its block.
export function dropCombinedBetLines(text: string): { text: string; skipped: SkippedLineEntry[] } {
  const skipped: SkippedLineEntry[] = [];
  const kept: string[] = [];
  let blockHeader = "";
  let lineInBlock = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      blockHeader = "";
      lineInBlock = 0;
      kept.push(line);
      continue;
    }
    if (lineInBlock === 0) blockHeader = line.trim();
    lineInBlock++;
    // The first line of a block is the capper header unless the block is a single line.
    if (lineInBlock > 1 && isCombinedBetLine(line)) {
      skipped.push({
        stage: "COMBINED_BET",
        capperName: blockHeader,
        rawText: line.trim(),
        reason: "More than one team or bet on one line",
      });
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), skipped };
}

// ---- league allowlist ----

const isAllowed = (allowed: Set<string>, sport: string) => allowed.has(sport.toUpperCase());

function notAllowed(p: ParsedPick, sport: string): SkippedLineEntry {
  return {
    stage: "LEAGUE_NOT_ALLOWED",
    capperName: p.capperName,
    rawText: p.raw,
    guessedSport: sport || null,
    reason: sport ? `League ${sport} is not in INGEST_ALLOWED_LEAGUES` : "No league could be read for this pick",
  };
}

// After the auto-resolver: a pick that resolved to a league outside the allowlist is skipped.
export function filterPicksByLeague(allowed: Set<string>, picks: ParsedPick[]): { keep: ParsedPick[]; skipped: SkippedLineEntry[] } {
  const keep: ParsedPick[] = [];
  const skipped: SkippedLineEntry[] = [];
  for (const p of picks) {
    if (isAllowed(allowed, p.sportName)) keep.push(p);
    else skipped.push(notAllowed(p, p.sportName));
  }
  return { keep, skipped };
}

// Before the auto-resolver: a name ambiguous between an allowed and a non-allowed league prefers the allowed one.
//   - exactly one allowed candidate -> the pick is resolved to it (no question, no schedule guess)
//   - no allowed candidate          -> LEAGUE_NOT_ALLOWED
//   - several allowed candidates    -> stays ambiguous, with only those options (it goes on to the resolver, then review)
export function narrowAmbiguousByLeague(allowed: Set<string>, picks: ParsedPick[]): { keep: ParsedPick[]; skipped: SkippedLineEntry[] } {
  const keep: ParsedPick[] = [];
  const skipped: SkippedLineEntry[] = [];
  for (const p of picks) {
    if (!p.ambiguous || p.ambiguous.length === 0) {
      keep.push(p);
      continue;
    }
    const ok = p.ambiguous.filter((o) => isAllowed(allowed, o.sport));
    if (ok.length === p.ambiguous.length) keep.push(p);
    else if (ok.length === 0) skipped.push(notAllowed(p, p.ambiguous.map((o) => o.sport).join("/")));
    else if (ok.length === 1) keep.push(resolveAmbiguousPick(p, ok[0]));
    else keep.push({ ...p, ambiguous: ok });
  }
  return { keep, skipped };
}
