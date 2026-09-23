// Point-in-time capper/category win-rate index for the parlay-level coverage
// re-run (docs/parlay-white-paper.md). Harness-only - not imported by src/.
// Reuses production's exact category taxonomy (pickCategory) so every
// win-rate this file computes is keyed the same way Sharp Money's 55% gate
// already keys its own (src/server/data/sharp-money.ts's QUALIFYING_WIN_PCT
// + getCapperCategoryRecords in src/server/data/picks.ts). The only thing
// this file adds is a date cutoff: every count is restricted to picks
// GRADED strictly before that cutoff (gradedAt < cutoff), never the
// capper's current/cumulative record - see the "point-in-time, not
// cumulative" rule this investigation must follow.
import { pickCategory, type PickCategoryKey } from "@/server/data/stats";
import type { BetType, Period } from "@prisma/client";

export type PitPick = {
  id: string;
  capperId: string;
  betType: string;
  period: string;
  betDetail: string | null;
  odds: number; // required by pickCategory's FAV_ML/DOG_ML favorite/underdog split
  line: number | null;
  status: string;
  gradedAt: Date | null;
  gameTime: Date;
  datePosted: Date;
  homeTeam: string;
  awayTeam: string;
  sportName: string;
};

type Entry = { date: Date; win: 0 | 1; push: boolean };

type Bucket = {
  dates: number[]; // epoch ms, ascending
  cumWins: number[]; // cumWins[i] = wins among dates[0..i-1]
  cumLosses: number[];
  cumPushes: number[];
};

function buildBucket(entries: Entry[]): Bucket {
  const sorted = [...entries].sort((a, b) => a.date.getTime() - b.date.getTime());
  const dates: number[] = new Array(sorted.length);
  const cumWins: number[] = new Array(sorted.length + 1).fill(0);
  const cumLosses: number[] = new Array(sorted.length + 1).fill(0);
  const cumPushes: number[] = new Array(sorted.length + 1).fill(0);
  for (let i = 0; i < sorted.length; i++) {
    dates[i] = sorted[i].date.getTime();
    cumWins[i + 1] = cumWins[i] + (sorted[i].win === 1 && !sorted[i].push ? 1 : 0);
    cumLosses[i + 1] = cumLosses[i] + (sorted[i].win === 0 && !sorted[i].push ? 1 : 0);
    cumPushes[i + 1] = cumPushes[i] + (sorted[i].push ? 1 : 0);
  }
  return { dates, cumWins, cumLosses, cumPushes };
}

// First index whose date >= cutoffMs (i.e. count of entries strictly before cutoff).
function countBefore(bucket: Bucket, cutoffMs: number): number {
  let lo = 0;
  let hi = bucket.dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bucket.dates[mid] < cutoffMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type Record55 = { wins: number; losses: number; pushes: number; n: number; winPct: number };

function recordFromBucket(bucket: Bucket, cutoffMs: number): Record55 {
  const idx = countBefore(bucket, cutoffMs);
  const wins = bucket.cumWins[idx];
  const losses = bucket.cumLosses[idx];
  const pushes = bucket.cumPushes[idx];
  const decided = wins + losses;
  return { wins, losses, pushes, n: wins + losses + pushes, winPct: decided > 0 ? (wins / decided) * 100 : 0 };
}

export const QUALIFYING_WIN_PCT = 55; // must match src/server/data/sharp-money.ts's own constant exactly

export class PointInTimeIndex {
  private byCapperCategory = new Map<string, Bucket>();
  private byCapperSportCategory = new Map<string, Bucket>();
  private byCapperAll = new Map<string, Bucket>();
  // Data-quality counter: how many decided picks had no gradedAt and fell
  // back to gameTime as the cutoff basis - reported, not silently absorbed.
  gradedAtFallbackCount = 0;
  totalDecidedCount = 0;

  constructor(picks: PitPick[]) {
    const rawByCapperCategory = new Map<string, Entry[]>();
    const rawByCapperSportCategory = new Map<string, Entry[]>();
    const rawByCapperAll = new Map<string, Entry[]>();

    for (const p of picks) {
      if (p.status !== "WIN" && p.status !== "LOSS" && p.status !== "PUSH") continue;
      this.totalDecidedCount++;
      let cutoffDate = p.gradedAt;
      if (!cutoffDate) {
        cutoffDate = p.gameTime;
        this.gradedAtFallbackCount++;
      }
      const entry: Entry = { date: cutoffDate, win: p.status === "WIN" ? 1 : 0, push: p.status === "PUSH" };

      const allKey = p.capperId;
      (rawByCapperAll.get(allKey) ?? rawByCapperAll.set(allKey, []).get(allKey)!).push(entry);

      // pickCategory types betType/period as Prisma's generated enums; PitPick
      // deliberately keeps them as plain strings (real DB rows always satisfy
      // the enum in practice) - narrow type-only cast at this one boundary.
      const category = pickCategory({ ...p, betType: p.betType as BetType, period: p.period as Period, sportName: p.sportName });
      if (category) {
        const catKey = p.capperId + "|" + category;
        (rawByCapperCategory.get(catKey) ?? rawByCapperCategory.set(catKey, []).get(catKey)!).push(entry);
        const sportCatKey = p.capperId + "|" + p.sportName.toUpperCase() + "|" + category;
        (rawByCapperSportCategory.get(sportCatKey) ?? rawByCapperSportCategory.set(sportCatKey, []).get(sportCatKey)!).push(
          entry
        );
      }
    }
    for (const [k, v] of rawByCapperCategory) this.byCapperCategory.set(k, buildBucket(v));
    for (const [k, v] of rawByCapperSportCategory) this.byCapperSportCategory.set(k, buildBucket(v));
    for (const [k, v] of rawByCapperAll) this.byCapperAll.set(k, buildBucket(v));
  }

  // The Section 3 / Sharp Money qualification gate: capperId+category, every
  // sport combined, exactly matching getCapperCategoryRecords' own key shape
  // (categoryRecordKey), just cut off at a point in time instead of "now".
  categoryRecord(capperId: string, category: PickCategoryKey, cutoff: Date): Record55 {
    const bucket = this.byCapperCategory.get(capperId + "|" + category);
    if (!bucket) return { wins: 0, losses: 0, pushes: 0, n: 0, winPct: 0 };
    return recordFromBucket(bucket, cutoff.getTime());
  }

  qualifies(capperId: string, category: PickCategoryKey, cutoff: Date): boolean {
    return this.categoryRecord(capperId, category, cutoff).winPct >= QUALIFYING_WIN_PCT;
  }

  sportCategoryRecord(capperId: string, sportName: string, category: PickCategoryKey, cutoff: Date): Record55 {
    const bucket = this.byCapperSportCategory.get(capperId + "|" + sportName.toUpperCase() + "|" + category);
    if (!bucket) return { wins: 0, losses: 0, pushes: 0, n: 0, winPct: 0 };
    return recordFromBucket(bucket, cutoff.getTime());
  }

  // Last-20-decided-picks record (any category, any sport) strictly before
  // cutoff - the final rung of bestAvailableWinPct's fallback ladder.
  last20(capperId: string, cutoff: Date): Record55 {
    const bucket = this.byCapperAll.get(capperId);
    if (!bucket) return { wins: 0, losses: 0, pushes: 0, n: 0, winPct: 0 };
    const idx = countBefore(bucket, cutoff.getTime());
    const from = Math.max(0, idx - 20);
    const wins = bucket.cumWins[idx] - bucket.cumWins[from];
    const losses = bucket.cumLosses[idx] - bucket.cumLosses[from];
    const pushes = bucket.cumPushes[idx] - bucket.cumPushes[from];
    const decided = wins + losses;
    return { wins, losses, pushes, n: idx - from, winPct: decided > 0 ? (wins / decided) * 100 : 0 };
  }

  // Mirrors bestAvailableWinPct (parlay-pool-section.tsx) exactly, point-in-
  // time: league(=sport)-scoped category record, else all-sport category
  // record, else last-20 overall, else -1 (unranked, sorts last).
  bestAvailableWinPct(capperId: string, sportName: string, category: PickCategoryKey | null, cutoff: Date): number {
    if (category) {
      const sportCard = this.sportCategoryRecord(capperId, sportName, category, cutoff);
      if (sportCard.n > 0) return sportCard.winPct;
      const overallCard = this.categoryRecord(capperId, category, cutoff);
      if (overallCard.n > 0) return overallCard.winPct;
    }
    const last20Card = this.last20(capperId, cutoff);
    if (last20Card.n > 0) return last20Card.winPct;
    return -1;
  }
}
