// Unique Picks: the /picks stat tile that counts each distinct bet ONCE, however many cappers took
// it. Pure and client-safe (no prisma, no queries) - it runs over the rows the page already loaded.
//
// A unique pick is one group of picks with the same game + period + market + side + line (props add
// player + stat; team totals add the team). Different lines are different picks. A pick with no stored side is
// keyed from its text (textSide / teamSide): HOME / AWAY when the text names exactly one of the game's teams,
// else TEXT:<cleaned text>. Pick.uniqueKey stores this key (lib/pick-unique-key.ts): changing it needs a backfill
// (scripts/backfill-unique-key.ts --text-only when only TEXT-fallback keys can move). This is NOT the
// badge's key (pick-display.ts sideGroupKey, which ignores the line and skips props): that key is
// left untouched so the "N cappers on this over" pills never move.
import { cleanPickText } from "@/lib/pick-display";
import { nrfiSide, totalSideFromText } from "@/lib/bet-line";

export type UniquePickInput = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  gameNumber?: number | null;
  betType: string;
  period: string;
  betDetail: string | null;
  pickedSide: string | null;
  category?: string | null;
  line: number | null;
  propMarket?: string | null;
  playerName?: string | null;
  status: string;
};

export type UniquePicksResult = {
  wins: number;
  losses: number;
  pushes: number;
  // Groups, pending ones included.
  unique: number;
  // Every pick the groups were built from.
  total: number;
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// The first number in the cleaned text, for old rows whose line column is empty.
function lineOf(p: UniquePickInput): string {
  if (p.line !== null && p.line !== undefined) return String(p.line);
  const m = cleanPickText(p.betDetail).match(/\d+(?:\.\d+)?/);
  return m ? String(Number(m[0])) : "";
}

function overUnder(p: UniquePickInput): string {
  const c = p.category ?? "";
  if (p.betType === "TOTAL") {
    if (c.endsWith("OVER")) return "OVER";
    if (c.endsWith("UNDER")) return "UNDER";
  }
  return totalSideFromText(p.betDetail) ?? "";
}

// ---- text fallback (only for picks with no structured side) ----------------------------------------
// R0: lowercase, apostrophes and periods dropped, "&" -> "and". Applied to the pick's text AND to team names, so
// "Hawai'i" / "Hawaii" and "Florida A&M" / "Florida A and M" compare equal.
const normalizeText = (s: string) => s.toLowerCase().replace(/['‘’.]/g, "").replace(/&/g, " and ");
const finish = (s: string) => norm(s.replace(/[^a-z0-9 ]+/g, " "));
const teamNorm = (team: string) => finish(normalizeText(team));

// R1: a number is stripped only when it stands alone (a line, odds, a count) - never inside a word, so f5, 1h,
// 1st, 49ers and 76ers survive. (The old /[+-]?\d+/ turned "Mets F5" into "mets f" and "49ers" into "ers".)
const stripNumbers = (s: string) => s.replace(/(^|[^a-z0-9])[+-]?\d+(?![a-z0-9])/g, "$1 ");

const OVER_UNDER_WORDS = /\bo\/u\b|\bover\/under\b|\b(over|under|ov|un)\b|\b[ou]\s?(?=\d)/g;

// The cleaned, normalized text with over/under words and the market words removed - numbers still in.
function baseText(text: string | null, extra: RegExp): string {
  return normalizeText(cleanPickText(text)).replace(OVER_UNDER_WORDS, " ").replace(extra, " ");
}

// The text of a team total / prop with the market words, numbers, odds and over/under removed.
function subjectText(text: string | null, extra: RegExp): string {
  return finish(stripNumbers(baseText(text, extra)));
}

// R4: period phrases a capper types, by the Period they name. FIRST_INNING is not a Period value, so text naming
// it always conflicts with the stored period ("Braves Phillies first inning" stored as FULL_GAME stays TEXT).
const W = (body: string) => new RegExp(`(?<![a-z0-9])(?:${body})(?![a-z0-9])`, "g");
const PERIOD_PHRASES: [string, RegExp][] = [
  ["FIRST_HALF", W("(?:first|1st)\\s+(?:5|five)(?:\\s+innings?)?|f5|1h|h1|(?:first|1st)\\s+half")],
  ["SECOND_HALF", W("2h|h2|(?:second|2nd)\\s+half")],
  ["FIRST_QUARTER", W("1q|q1|(?:first|1st)\\s+(?:quarter|qtr)")],
  ["SECOND_QUARTER", W("2q|q2|(?:second|2nd)\\s+(?:quarter|qtr)")],
  ["THIRD_QUARTER", W("3q|q3|(?:third|3rd)\\s+(?:quarter|qtr)")],
  ["FOURTH_QUARTER", W("4q|q4|(?:fourth|4th)\\s+(?:quarter|qtr)")],
  ["FIRST_PERIOD", W("1p|p1|(?:first|1st)\\s+period")],
  ["SECOND_PERIOD", W("2p|p2|(?:second|2nd)\\s+period")],
  ["THIRD_PERIOD", W("3p|p3|(?:third|3rd)\\s+period")],
  ["FIRST_INNING", W("(?:first|1st)\\s+inning")],
  ["REGULATION", W("regulation")],
];

// R3: HOME / AWAY only when the WHOLE remaining text is one team's full name, the end of it (nickname: "red sox")
// or the start of it (school / city: "texas state"), and the other team doesn't match too. No fuzzy or shared-word
// matching. null = keep the text.
function exactTeamSide(subject: string, homeTeam: string, awayTeam: string): "HOME" | "AWAY" | null {
  if (!subject) return null;
  const is = (team: string) => {
    const t = teamNorm(team);
    return t !== "" && (subject === t || t.endsWith(" " + subject) || t.startsWith(subject + " "));
  };
  const h = is(homeTeam);
  const a = is(awayTeam);
  return h && !a ? "HOME" : a && !h ? "AWAY" : null;
}

// A MONEYLINE / SPREAD pick with no stored pickedSide: HOME / AWAY when its text names exactly one of the game's
// teams, else TEXT:<the cleaned text>. Period words are stripped only when they agree with the stored period (R4);
// a period that disagrees keeps the text as is and is never mapped to a team. `extra` = the market words (R5).
function textSide(p: UniquePickInput, extra: RegExp): string {
  let s = baseText(p.betDetail, extra); // digits still in, so "first 5" / "1st 5" are seen as periods
  const named = PERIOD_PHRASES.filter(([, re]) => new RegExp(re.source).test(s));
  if (named.some(([period]) => period !== p.period)) return "TEXT:" + finish(stripNumbers(s));
  for (const [, re] of named) s = s.replace(re, " ");
  const subject = finish(stripNumbers(s));
  return exactTeamSide(subject, p.homeTeam, p.awayTeam) ?? "TEXT:" + subject;
}

function nameMatches(subject: string, team: string): number {
  const t = teamNorm(team);
  if (!subject || !t) return 0;
  if (subject.includes(t)) return 2;
  const last = t.split(" ").pop() ?? "";
  return last.length >= 3 && subject.split(" ").includes(last) ? 1 : 0;
}

// HOME / AWAY when the text names one of the game's teams (full name or nickname), else the text.
function teamSide(p: UniquePickInput): string {
  const subject = subjectText(p.betDetail, /\b(team|total|tt)\b/g);
  const h = nameMatches(subject, p.homeTeam);
  const a = nameMatches(subject, p.awayTeam);
  if (h > a) return "HOME";
  if (a > h) return "AWAY";
  return "TEXT:" + subject;
}

export function uniquePickKey(p: UniquePickInput): string {
  const game = [p.homeTeam, p.awayTeam, p.gameTime.getTime(), p.gameNumber ?? ""].join("|");
  let market: string[];
  switch (p.betType) {
    // R5: "ml" / "moneyline" / "money line" are market words; a bare "line" is not, so "Pirates 20 Line" stays text.
    case "MONEYLINE":
      market = [p.pickedSide ?? textSide(p, /\b(ml|moneyline|money\s+line)\b/g)];
      break;
    case "SPREAD":
      market = [p.pickedSide ?? textSide(p, /\b(spread)\b/g), lineOf(p)];
      break;
    case "TOTAL":
      market = [overUnder(p), lineOf(p)];
      break;
    // R2: the stored side first (set at import from the matched game; it agreed with the text on 308/308 prod team
    // totals that had both); the text only when it's missing.
    case "TEAM_TOTAL":
      market = [p.pickedSide ?? teamSide(p), overUnder(p), lineOf(p)];
      break;
    case "NRFI": {
      const c = p.category ?? "";
      market = [c === "NRFI" || c === "YRFI" ? c : nrfiSide(p.betDetail) === "YES_RUN" ? "YRFI" : "NRFI"];
      break;
    }
    case "PLAYER_PROP":
      market = [
        p.playerName ? norm(p.playerName) : "TEXT:" + subjectText(p.betDetail, /\b(to|record|score|prop|player)\b/g),
        p.propMarket ?? "",
        overUnder(p),
        lineOf(p),
      ];
      break;
    default:
      market = ["TEXT:" + norm(cleanPickText(p.betDetail))];
  }
  return [game, p.period, p.betType, ...market].join("||");
}

type Graded = "WIN" | "LOSS" | "PUSH";
const GRADED = new Set<string>(["WIN", "LOSS", "PUSH"]);

// Dev-only by default: graded copies of one bet that disagree mean a grading bug.
function defaultDisagree(key: string, ids: string[], counts: Record<Graded, number>) {
  if (process.env.NODE_ENV !== "production") {
    console.warn("[unique-picks] graded copies of one bet disagree", { key, ids, counts });
  }
}

// W-L-P over the groups. A group counts as pending only when ALL its picks are pending; otherwise
// it takes the graded result. Disagreeing graded copies take the majority result (a tie counts in
// no bucket) and are reported through `onDisagree`.
export function summarizeUniquePicks(
  picks: UniquePickInput[],
  onDisagree: (key: string, ids: string[], counts: Record<Graded, number>) => void = defaultDisagree
): UniquePicksResult {
  const groups = new Map<string, UniquePickInput[]>();
  for (const p of picks) {
    const key = uniquePickKey(p);
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const out: UniquePicksResult = { wins: 0, losses: 0, pushes: 0, unique: groups.size, total: picks.length };
  groups.forEach((members, key) => {
    const counts: Record<Graded, number> = { WIN: 0, LOSS: 0, PUSH: 0 };
    for (const m of members) if (GRADED.has(m.status)) counts[m.status as Graded]++;
    const kinds = (Object.keys(counts) as Graded[]).filter((k) => counts[k] > 0);
    if (kinds.length === 0) return; // pending / cancelled only
    if (kinds.length > 1) {
      onDisagree(key, members.filter((m) => GRADED.has(m.status)).map((m) => m.id), counts);
    }
    const top = Math.max(...kinds.map((k) => counts[k]));
    const winners = kinds.filter((k) => counts[k] === top);
    if (winners.length !== 1) return; // tie: no majority
    if (winners[0] === "WIN") out.wins++;
    else if (winners[0] === "LOSS") out.losses++;
    else out.pushes++;
  });
  return out;
}
