// The Parlay Generator replay's inputs, shared by parlay-record-scope-replay.ts
// and parlay-soft-sample-replay.ts so both replay the identical slates.
//
// Each (user, Eastern day) in the snapshot is one full-slate Generate: the
// day's picks in the Live leagues are the board (as pending), and the records
// are point-in-time - only that user's picks graded on games before the day
// count, per capper and category, all leagues and per league, the way
// getCapperRecordBundle aggregates them. Categories come from pickCategory, as
// the boards stamp them. Read-only: one SELECT.
import { prisma } from "@/lib/prisma";
import { pickCategory, PICK_CATEGORY_LABELS, type CategoryBreakdownItem, type PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { LIVE_SPORTS } from "@/server/data/odds";
import { toExpanderPick } from "@/server/data/expander-pick";
import { easternDateKey, startOfEasternDay } from "@/lib/dates";
import { leagueRecordKey, categoryRecordKey } from "@/lib/record-keys";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GeneratorSettings, GeneratorSnapshot } from "@/lib/parlay/generator";
import { assertNotProd } from "./prod-guard.mjs";

export const WARMUP_DAYS = 14;
export const REPLAY_SETTINGS: { name: string; settings: GeneratorSettings }[] = [
  { name: "4 legs, max 1/game", settings: { legCount: 4, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" } },
  { name: "8 legs, max 2/game", settings: { legCount: 8, maxLegsPerGame: 2, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" } },
];

export type ReplaySlate = { day: string; user: string; now: Date; snapshot: GeneratorSnapshot };

type Row = {
  id: string;
  userId: string;
  capperId: string;
  capperName: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  betType: string;
  betDetail: string | null;
  odds: number;
  line: number | null;
  period: string;
  units: number;
  status: string;
  datePosted: Date;
  gameTime: Date;
  pickedSide: string | null;
  mlFavoredSide: string | null;
  propMarket: string | null;
};

const col = (w: number, l: number, p: number) => ({ wins: w, losses: l, pushes: p, winPct: w + l > 0 ? (w / (w + l)) * 100 : 0, count: w + l + p });

export function assertLocalReplayDb() {
  const url = process.env.DATABASE_URL ?? "";
  assertNotProd(url, "replay DATABASE_URL");
  if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("replay must run against a local disposable DB");
}

export async function loadReplaySlates(): Promise<{ slates: ReplaySlate[]; window: string; users: number }> {
  assertLocalReplayDb();
  const rows = (await prisma.$queryRawUnsafe(`
    SELECT p.id, p."userId", p."capperId", c.name AS "capperName", s.name AS sport, p."homeTeam", p."awayTeam",
           p."betType"::text AS "betType", p."betDetail", p.odds, p.line, p.period::text AS period, p.units,
           p.status::text AS status, p."datePosted", p."gameTime", p."pickedSide"::text AS "pickedSide",
           p."mlFavoredSide"::text AS "mlFavoredSide", p."propMarket"::text AS "propMarket"
    FROM picks p JOIN cappers c ON c.id = p."capperId" JOIN sports s ON s.id = p."sportId"
    WHERE p.status::text <> 'CANCELLED'
    ORDER BY p."gameTime", p.id`)) as Row[];
  const live = new Map(LIVE_SPORTS.map((s) => [s.label.toLowerCase(), s]));
  const catOf = new Map<string, PickCategoryKey | null>();
  for (const r of rows) catOf.set(r.id, pickCategory({ ...r, sportName: r.sport } as Parameters<typeof pickCategory>[0]));

  const days = Array.from(new Set(rows.map((r) => easternDateKey(r.gameTime)))).sort();
  const replayDays = days.slice(WARMUP_DAYS);
  const users = Array.from(new Set(rows.map((r) => r.userId))).sort();
  const slates: ReplaySlate[] = [];

  for (const user of users) {
    const mine = rows.filter((r) => r.userId === user);
    for (const day of replayDays) {
      const pool = mine.filter((r) => easternDateKey(r.gameTime) === day && live.has(r.sport.toLowerCase()) && catOf.get(r.id));
      if (pool.length === 0) continue;
      const dayStart = startOfEasternDay(pool[0].gameTime);
      const history = mine.filter((r) => r.gameTime.getTime() < dayStart.getTime() && (r.status === "WIN" || r.status === "LOSS" || r.status === "PUSH"));

      const agg = new Map<string, [number, number, number]>();
      const bump = (k: string, s: string) => {
        const a = agg.get(k) ?? [0, 0, 0];
        a[s === "WIN" ? 0 : s === "LOSS" ? 1 : 2]++;
        agg.set(k, a);
      };
      for (const h of history) {
        const c = catOf.get(h.id);
        if (!c) continue;
        bump(categoryRecordKey(h.capperId, c), h.status);
        bump(leagueRecordKey(h.capperId, live.get(h.sport.toLowerCase())?.label ?? h.sport, c), h.status);
      }
      const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
      const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
      const games = new Map<string, GeneratorGame>();
      for (const r of pool) {
        const sport = live.get(r.sport.toLowerCase())!;
        const category = catOf.get(r.id)!;
        const ck = categoryRecordKey(r.capperId, category);
        const a = agg.get(ck);
        categoryRecords[ck] = a ? { key: category, label: PICK_CATEGORY_LABELS[category], ...col(...a) } : null;
        const lk = leagueRecordKey(r.capperId, sport.label, category);
        const l = agg.get(lk) ?? [0, 0, 0];
        leagueRecords.records[lk] = a ? { category, label: PICK_CATEGORY_LABELS[category], overall: col(...a), league: col(...l) } : null;
        const gameId = `${sport.label}|${r.awayTeam}@${r.homeTeam}|${r.gameTime.toISOString()}`;
        const pick = toExpanderPick(
          { ...r, capper: { name: r.capperName, colorTag: null, isFavorite: false }, oddsSource: null, gameNumber: null, status: "PENDING" } as unknown as Parameters<typeof toExpanderPick>[0],
          { id: gameId, homeTeam: r.homeTeam, awayTeam: r.awayTeam, commenceTime: r.gameTime.toISOString() },
          sport.key,
          sport.label
        ) as GeneratorPick;
        const g = games.get(gameId) ?? { gameId, gameLabel: pick.gameLabel, gameTime: r.gameTime.toISOString(), leagueName: sport.label, picks: [], doubleheader: false };
        g.picks.push(pick);
        games.set(gameId, g);
      }
      slates.push({
        day,
        user: user.slice(-6),
        now: dayStart,
        snapshot: { builtAt: dayStart.toISOString(), games: Array.from(games.values()), slipPicks: [], targets: [], leagueRecords, categoryRecords },
      });
    }
  }
  return { slates, window: `${replayDays[0]} .. ${replayDays[replayDays.length - 1]} (after ${WARMUP_DAYS} warm-up days)`, users: users.length };
}

export const wl = (r: { wins: number; losses: number } | null | undefined) =>
  r && r.wins + r.losses > 0 ? `${r.wins}-${r.losses} (${((r.wins / (r.wins + r.losses)) * 100).toFixed(1)}%)` : "none";
