// Unique Picks: the /picks stat tile that counts each distinct bet ONCE, however many cappers took
// it. Pure and client-safe (no prisma, no queries) - it runs over the rows the page already loaded.
//
// A unique pick is one group of picks with the same game + period + market + side + line (props add
// player + stat; team totals add the team). Different lines are different picks. This is NOT the
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

// The text of a team total / prop with the market words, numbers, odds and over/under removed.
function subjectText(text: string | null, extra: RegExp): string {
  return norm(
    cleanPickText(text)
      .toLowerCase()
      .replace(/\bo\/u\b|\bover\/under\b|\b(over|under|ov|un)\b|\b[ou]\s?(?=\d)/g, " ")
      .replace(extra, " ")
      .replace(/[+-]?\d+(?:\.\d+)?/g, " ")
      .replace(/[^a-z0-9.' ]+/g, " ")
  );
}

function nameMatches(subject: string, team: string): number {
  const t = norm(team);
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
    case "MONEYLINE":
      market = [p.pickedSide ?? "TEXT:" + subjectText(p.betDetail, /\b(ml|moneyline)\b/g)];
      break;
    case "SPREAD":
      market = [p.pickedSide ?? "TEXT:" + subjectText(p.betDetail, /\b(spread)\b/g), lineOf(p)];
      break;
    case "TOTAL":
      market = [overUnder(p), lineOf(p)];
      break;
    case "TEAM_TOTAL":
      market = [teamSide(p), overUnder(p), lineOf(p)];
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
