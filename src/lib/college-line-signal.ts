import type { AmbiguousOption, ParsedPick } from "@/lib/parse-catalog";
import { teamNameEndsWith } from "@/lib/team-name-match";

// Option D: two per-pick signals for a shared school's NCAAF / NCAAB question, for
// the picks the card context (Option C) cannot help - a single-line batch.
//   line_vs_posted - the pick's spread / total against each league's posted line
//                    for that school's next game.
//   capper_history - the capper's own graded NCAAF vs NCAAB picks, last 30 days.
// Pure: the hierarchy takes the posted lines and the history as injected lookups
// (server/data/catalog-disambiguation-checks.ts supplies the real ones).

// A pick's line may sit this far (inclusive) from a league's posted line and still
// count as that league's game. Covers bought points and a line that has moved.
export const COLLEGE_LINE_TOLERANCE = 1.5;

// History must be this big, and this lopsided, to speak for a moneyline.
export const HISTORY_MIN_PICKS = 10;
export const HISTORY_MIN_SHARE = 0.9;
export const HISTORY_WINDOW_DAYS = 30;

// One school's next game in one league: its own spread outcome (signed from the
// school's side) and the game total. null = that market is not posted.
export type PostedCollegeLines = { spread: number | null; total: number | null };
// Keyed `${nickname}|${sport}`, the same key the schedule checks use.
export type PostedLinesByTeam = Record<string, PostedCollegeLines>;
export type CollegeLineQuery = { nickname: string; sport: string };

// A capper's graded college picks in the window, per league.
export type CapperLeagueCounts = { NCAAF: number; NCAAB: number };
// Keyed by the capper's name, lowercased.
export type CapperLeagueHistory = Record<string, CapperLeagueCounts>;

export type LineVerdict =
  | { kind: "resolved"; sport: string }
  // Both within tolerance, neither within, or a league with no posted line: the
  // line has nothing to say, which is the only case history may fill in.
  | { kind: "inconclusive" }
  // The signal does not apply to this pick (a moneyline, a partial game, a team
  // total, no parsed line).
  | { kind: "not_applicable" };

// The pair a college signal chooses between: one NCAAF and one NCAAB option.
export function collegePair(shown: AmbiguousOption[]): { ncaaf: AmbiguousOption; ncaab: AmbiguousOption } | null {
  if (shown.length !== 2 || !shown.every((o) => o.sport === "NCAAF" || o.sport === "NCAAB")) return null;
  const ncaaf = shown.find((o) => o.sport === "NCAAF");
  const ncaab = shown.find((o) => o.sport === "NCAAB");
  return ncaaf && ncaab ? { ncaaf, ncaab } : null;
}

// Whether the line signal applies to this pick at all: a full-game spread or game
// total with a parsed number. Posted markets are full-game, and the cache holds no
// team total, so those stay on the plausibility cutoffs.
export function lineSignalApplies(pick: Pick<ParsedPick, "ambiguousBetType" | "ambiguousLine" | "ambiguousPartialGame">): boolean {
  if (pick.ambiguousPartialGame) return false;
  if (pick.ambiguousBetType !== "SPREAD" && pick.ambiguousBetType !== "TOTAL") return false;
  return pick.ambiguousLine !== null && pick.ambiguousLine !== undefined;
}

export function lineVerdict(
  pick: Pick<ParsedPick, "ambiguousBetType" | "ambiguousLine" | "ambiguousPartialGame">,
  shown: AmbiguousOption[],
  posted: PostedLinesByTeam
): LineVerdict {
  const pair = collegePair(shown);
  if (!pair || !lineSignalApplies(pick)) return { kind: "not_applicable" };
  const line = pick.ambiguousLine as number;
  const market = pick.ambiguousBetType === "SPREAD" ? "spread" : "total";
  const pointOf = (o: AmbiguousOption): number | null => posted[o.nickname + "|" + o.sport]?.[market] ?? null;
  const f = pointOf(pair.ncaaf);
  const b = pointOf(pair.ncaab);
  // Both leagues need a posted line: a league with none cannot win, and the other
  // must not win by default (the pick may be on the league with no line).
  if (f === null || b === null) return { kind: "inconclusive" };
  const near = (x: number) => Math.abs(x - line) <= COLLEGE_LINE_TOLERANCE + 1e-9;
  const fNear = near(f);
  const bNear = near(b);
  if (fNear === bNear) return { kind: "inconclusive" };
  return { kind: "resolved", sport: fNear ? "NCAAF" : "NCAAB" };
}

// The league a capper's history names, or null when it is thin or not lopsided.
export function historyLeague(counts: CapperLeagueCounts | undefined): "NCAAF" | "NCAAB" | null {
  if (!counts) return null;
  const total = counts.NCAAF + counts.NCAAB;
  if (total < HISTORY_MIN_PICKS) return null;
  if (counts.NCAAF / total >= HISTORY_MIN_SHARE) return "NCAAF";
  if (counts.NCAAB / total >= HISTORY_MIN_SHARE) return "NCAAB";
  return null;
}

// ---- Posted lines out of an odds board (pure; the server check feeds it a board) ----

type BoardGame = {
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  bookmakers: { markets: { key: string; outcomes: { name: string; point?: number | null }[] }[] }[];
};

// The school's posted spread and total in one game: the first bookmaker that carries
// each market, as the other market readers (findMarketSpreadLine) do.
export function postedLinesFromGame(game: BoardGame, nickname: string, sportKey: string): PostedCollegeLines | null {
  const home = teamNameEndsWith(game.homeTeam, nickname, sportKey);
  const away = teamNameEndsWith(game.awayTeam, nickname, sportKey);
  if (home === away) return null; // names neither side, or both
  const team = home ? game.homeTeam : game.awayTeam;
  let spread: number | null = null;
  let total: number | null = null;
  for (const book of game.bookmakers) {
    if (spread === null) {
      const p = book.markets.find((m) => m.key === "spreads")?.outcomes.find((o) => o.name === team)?.point;
      if (typeof p === "number") spread = p;
    }
    if (total === null) {
      const p = book.markets.find((m) => m.key === "totals")?.outcomes.find((o) => o.name === "Over")?.point;
      if (typeof p === "number") total = p;
    }
  }
  return { spread, total };
}

// The school's next game on a board (not yet started, nearest start) and its lines.
// null when the school has no upcoming game on the board.
export function postedLinesForSchool(games: BoardGame[], nickname: string, sportKey: string, now: Date): PostedCollegeLines | null {
  const upcoming = games
    .filter((g) => {
      const t = Date.parse(g.commenceTime);
      return Number.isFinite(t) && t > now.getTime() && postedLinesFromGame(g, nickname, sportKey) !== null;
    })
    .sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime));
  return upcoming.length > 0 ? postedLinesFromGame(upcoming[0], nickname, sportKey) : null;
}
