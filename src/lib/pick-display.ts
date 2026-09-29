// Display-only helpers for the /picks ledger: the pick label, its market tag,
// the Live/Upcoming/Settled split and the "N cappers on this side" hint.
// Nothing here touches grading or import - it only reads stored pick fields.
// Client-safe (no prisma import).
import { extractLine, formatPickLabel, betTypeLabel, nrfiSide, totalSideFromText } from "@/lib/bet-line";

export type LedgerPickInput = {
  id: string;
  capperId: string;
  sportName: string;
  homeTeam: string;
  awayTeam: string;
  betType: string;
  betDetail: string | null;
  line: number | null;
  period: string;
  pickedSide: "HOME" | "AWAY" | null;
  odds: number;
  status: string;
  gameTime: Date;
};

// How long after first pitch/tip a pending pick is still shown as "Live". Past
// this it is just an ungraded pick, so it reads "Pending" instead of implying
// a game is still in progress.
export const LIVE_WINDOW_MS = 8 * 60 * 60 * 1000;

const PERIOD_TAG: Record<string, string> = {
  SECOND_HALF: "2H",
  FIRST_QUARTER: "Q1",
  SECOND_QUARTER: "Q2",
  THIRD_QUARTER: "Q3",
  FOURTH_QUARTER: "Q4",
  FIRST_PERIOD: "P1",
  SECOND_PERIOD: "P2",
  THIRD_PERIOD: "P3",
};

// Sports whose first-half period is the "F5" innings split (see
// bet-type-filter.ts firstHalfLabelPrefixForChipSet: MLB is the only chip set
// with F5 keys). Everything else says 1H.
function firstHalfPrefix(sportName: string): string {
  return sportName === "MLB" ? "F5" : "1H";
}

// Strips things that have their own column (odds, units) or are formatting
// noise from the capper's stored text: "over 5.5 - -135", "Yankees ML (-120)",
// "Lakers -4.5 - 2u", "over 5.5 @ -135".
export function cleanPickText(text: string | null | undefined): string {
  let t = (text ?? "").trim();
  // Trailing units, e.g. "- 2u", "(1.5u)", "2 units".
  t = t.replace(/[\s\-–—@|,(]*\b\d+(?:\.\d+)?\s*(?:u|units?)\b\)?\s*$/i, "");
  // Trailing odds after a separator or in parens/after @: "- -135", "(+110)", "@ -120".
  t = t.replace(/[\s]*(?:[-–—@|,]\s*|\()\s*[+-]\d{3,4}\)?\s*$/, "");
  // Collapse leftover doubled/dangling separators.
  t = t.replace(/\s*[-–—]\s*[-–—]\s*/g, " - ").replace(/[\s\-–—@|,]+$/, "").replace(/\s{2,}/g, " ");
  return t.trim();
}

function signed(n: number): string {
  return n > 0 ? "+" + n : String(n);
}

function pickedTeam(p: LedgerPickInput): string | null {
  if (p.pickedSide === "HOME") return p.homeTeam;
  if (p.pickedSide === "AWAY") return p.awayTeam;
  return null;
}

// The single place a pick's display label is built. Uses structured fields
// (pickedSide/line/betType) where they exist and falls back to the cleaned
// stored text. A future import-time label generator can replace this function
// wholesale - callers only depend on its (pick) => string shape.
export function buildPickLabel(p: LedgerPickInput): string {
  const cleaned = cleanPickText(p.betDetail);
  switch (p.betType) {
    case "MONEYLINE": {
      const team = pickedTeam(p);
      if (team) return team;
      break;
    }
    case "SPREAD": {
      const team = pickedTeam(p);
      const line = p.line ?? (cleaned ? extractLine("SPREAD", cleaned) : null);
      if (team && line !== null) return team + " " + signed(line);
      break;
    }
    case "TOTAL": {
      const side = totalSideFromText(cleaned);
      const line = p.line ?? extractLine("TOTAL", cleaned);
      if (side && line !== null) return (side === "OVER" ? "Over " : "Under ") + line;
      break;
    }
    case "NRFI":
      return nrfiSide(p.betDetail) === "YES_RUN" ? "Run in the 1st inning" : "No run in the 1st inning";
  }
  return formatPickLabel(cleaned || null, p.betType, p.line) ?? betTypeLabel(p.betType);
}

// The small market tag after the label (ML, Spread, Run line, F5 total, ...).
export function marketTag(p: { betType: string; period: string; sportName: string; betDetail: string | null }): string {
  if (p.betType === "NRFI") return nrfiSide(p.betDetail) === "YES_RUN" ? "YRFI" : "NRFI";
  const base =
    p.betType === "MONEYLINE"
      ? "ML"
      : p.betType === "SPREAD"
        ? p.sportName === "MLB" || p.sportName === "KBO"
          ? "Run line"
          : p.sportName === "NHL"
            ? "Puck line"
            : "Spread"
        : p.betType === "TOTAL"
          ? "Total"
          : p.betType === "TEAM_TOTAL"
            ? "Team total"
            : p.betType === "PLAYER_PROP"
              ? "Player prop"
              : betTypeLabel(p.betType);
  const prefix = p.period === "FIRST_HALF" ? firstHalfPrefix(p.sportName) : PERIOD_TAG[p.period];
  if (!prefix) return base;
  // "F5 ML" / "F5 total" / "Q1 spread" - lowercase the market word after a prefix.
  return prefix + " " + (base === "ML" ? "ML" : base.toLowerCase());
}

export type LedgerSection = "live" | "upcoming" | "settled";

export function sectionFor(p: { status: string; gameTime: Date }, now: Date): LedgerSection {
  if (p.status !== "PENDING") return "settled";
  return p.gameTime.getTime() <= now.getTime() ? "live" : "upcoming";
}

// True only while a pending pick's game is plausibly still in progress.
export function isLiveNow(p: { status: string; gameTime: Date }, now: Date): boolean {
  const started = now.getTime() - p.gameTime.getTime();
  return p.status === "PENDING" && started >= 0 && started <= LIVE_WINDOW_MS;
}

// Live/Upcoming/Settled in that order, empty ones dropped. Upcoming ascending
// by game time, Live ascending (earliest start first), Settled descending.
export function splitIntoSections<T extends { status: string; gameTime: Date }>(
  picks: T[],
  now: Date
): { key: LedgerSection; picks: T[] }[] {
  const buckets: Record<LedgerSection, T[]> = { live: [], upcoming: [], settled: [] };
  for (const p of picks) buckets[sectionFor(p, now)].push(p);
  const asc = (a: T, b: T) => a.gameTime.getTime() - b.gameTime.getTime();
  buckets.live.sort(asc);
  buckets.upcoming.sort(asc);
  buckets.settled.sort((a, b) => asc(b, a));
  return (["live", "upcoming", "settled"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, picks: buckets[key] }));
}

// pickId -> hint text, for picks where 2+ distinct cappers in the loaded set
// took the same game + market + side. Only sides we can identify reliably:
// over/under on totals and team totals, NRFI/YRFI, and a picked team on
// moneyline/spread (needs pickedSide). Player props are skipped.
export function consensusHints(picks: LedgerPickInput[]): Map<string, string> {
  const groups = new Map<string, { cappers: Set<string>; ids: string[]; word: string }>();
  for (const p of picks) {
    let side: string | null = null;
    let word = "side";
    if (p.betType === "TOTAL" || p.betType === "TEAM_TOTAL") {
      const s = totalSideFromText(p.betDetail);
      if (s) {
        side = s + (p.betType === "TEAM_TOTAL" ? ":" + cleanPickText(p.betDetail).toLowerCase().replace(/\b(over|under)\b|[\d.]+/g, "").trim() : "");
        word = s === "OVER" ? "over" : "under";
      }
    } else if (p.betType === "NRFI") {
      const s = nrfiSide(p.betDetail) === "YES_RUN" ? "YRFI" : "NRFI";
      side = s;
      word = s === "YRFI" ? "YRFI" : "NRFI";
    } else if (p.betType === "MONEYLINE" || p.betType === "SPREAD") {
      side = p.pickedSide;
    }
    if (!side) continue;
    const key = [p.homeTeam, p.awayTeam, p.gameTime.getTime(), p.betType, p.period, side].join("|");
    const g = groups.get(key) ?? { cappers: new Set<string>(), ids: [], word };
    g.cappers.add(p.capperId);
    g.ids.push(p.id);
    groups.set(key, g);
  }
  const hints = new Map<string, string>();
  for (const g of Array.from(groups.values())) {
    if (g.cappers.size < 2) continue;
    const text = g.cappers.size + " cappers on this " + g.word;
    for (const id of g.ids) hints.set(id, text);
  }
  return hints;
}

export function capperInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function formatOdds(odds: number): string {
  return odds > 0 ? "+" + odds : String(odds);
}

// Units returned on a win / lost on a loss, mirroring stats.ts's
// unitsWonOnBet (duplicated here because stats.ts pulls in prisma and this
// file must stay client-safe).
export function winUnits(units: number, odds: number): number {
  if (odds === 0) return 0;
  return odds > 0 ? units * (odds / 100) : units * (100 / Math.abs(odds));
}
