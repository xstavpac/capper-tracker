// 7D / 30D Unique Momentum (getMomentumDaily { unique: true }) against the Today view's app-code rule
// (momentum.ts uniqueMomentumEvents), on the SAME fixture picks in a real database:
//   - for every Eastern day of the window, the SQL's net equals the TS rule run over that day's picks,
//     unfiltered and under each of the card's range filters (capper / sport / result);
//   - the hand-worked nets: duplicate losses count once (averaged), majority result wins, a tie or a PUSH
//     majority moves nothing, different lines are different bets, odds 0 wins pay 0, PENDING is ignored, an
//     11:30 PM ET game stays on its Eastern day, out-of-window days and other users' picks are excluded;
//   - All mode (no `unique`) is unchanged: the plain per-day sum.
//
// Everything runs inside one interactive transaction that is rolled back - no row survives the test.
//   npx tsx src/server/data/momentum-daily-unique-parity-acceptance-test.ts   (DATABASE_URL must be localhost)
import type { Prisma } from "@prisma/client";
import { easternDateKey, easternWallTime } from "@/lib/dates";
import { uniqueMomentumEvents, type UniqueMomentumPick } from "@/lib/momentum";
import { winUnits } from "@/lib/pick-display";
import { withUniqueKey } from "@/lib/pick-unique-key";
import type { DailyNet } from "@/lib/momentum-daily";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function isLocal(url: string | undefined): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url ?? "").hostname);
  } catch {
    return false;
  }
}

const PREFIX = "__MomUniq__";
const END_KEY = "2026-11-10"; // 7D window: 2026-11-04 .. 2026-11-10
const MIN = 60000;

type Status = "WIN" | "LOSS" | "PUSH" | "PENDING";
type Fx = {
  who: "A" | "B" | "C" | "OTHER";
  sport?: "S1" | "S2";
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  betType: "MONEYLINE" | "SPREAD" | "TOTAL";
  betDetail: string;
  pickedSide?: "HOME" | "AWAY";
  line?: number;
  status: Status;
  units: number;
  odds: number;
  graded?: boolean;
};

const LAL = { homeTeam: "Los Angeles Lakers", awayTeam: "Boston Celtics" };
const NYK = { homeTeam: "New York Knicks", awayTeam: "Miami Heat" };
const NYY = { homeTeam: "New York Yankees", awayTeam: "Boston Red Sox" };
const at = (key: string, hour: number, min = 0) => new Date(easternWallTime(key, hour).getTime() + min * MIN);

// Hand-worked Unique nets per day (unfiltered) are noted beside each group.
const FIXTURES: Fx[] = [
  // 2026-11-05: three cappers on one losing ML -> ONE bet, average loss (-1 -2 -1)/3 = -1.3333...
  { who: "A", ...LAL, gameTime: at("2026-11-05", 19), betType: "MONEYLINE", betDetail: "Lakers ML", pickedSide: "HOME", status: "LOSS", units: 1, odds: -110 },
  { who: "B", ...LAL, gameTime: at("2026-11-05", 19), betType: "MONEYLINE", betDetail: "Lakers ML", pickedSide: "HOME", status: "LOSS", units: 2, odds: -120 },
  { who: "C", sport: "S2", ...LAL, gameTime: at("2026-11-05", 19), betType: "MONEYLINE", betDetail: "Lakers ML", pickedSide: "HOME", status: "LOSS", units: 1, odds: 105 },
  //   a distinct spread win, 2u at +150 = +3
  { who: "A", ...LAL, gameTime: at("2026-11-05", 19), betType: "SPREAD", betDetail: "Lakers -3.5", pickedSide: "HOME", line: -3.5, status: "WIN", units: 2, odds: 150 },
  // 2026-11-06: majority WIN (2 of 3) -> average of the WIN copies (0.90909 + 2.4) / 2 = 1.65454...
  { who: "A", ...NYK, gameTime: at("2026-11-06", 19), betType: "TOTAL", betDetail: "Over 220.5", line: 220.5, status: "WIN", units: 1, odds: -110 },
  { who: "B", ...NYK, gameTime: at("2026-11-06", 19), betType: "TOTAL", betDetail: "Over 220.5", line: 220.5, status: "WIN", units: 2, odds: 120 },
  { who: "C", ...NYK, gameTime: at("2026-11-06", 19), betType: "TOTAL", betDetail: "Over 220.5", line: 220.5, status: "LOSS", units: 1, odds: -110 },
  //   tie (1 WIN, 1 LOSS) -> 0
  { who: "A", ...NYK, gameTime: at("2026-11-06", 19), betType: "MONEYLINE", betDetail: "Heat ML", pickedSide: "AWAY", status: "WIN", units: 1, odds: -110 },
  { who: "B", ...NYK, gameTime: at("2026-11-06", 19), betType: "MONEYLINE", betDetail: "Heat ML", pickedSide: "AWAY", status: "LOSS", units: 1, odds: -110 },
  //   PUSH majority (2 PUSH, 1 WIN) -> 0
  { who: "A", ...NYK, gameTime: at("2026-11-06", 19), betType: "SPREAD", betDetail: "Heat +4.5", pickedSide: "AWAY", line: 4.5, status: "PUSH", units: 1, odds: -110 },
  { who: "B", ...NYK, gameTime: at("2026-11-06", 19), betType: "SPREAD", betDetail: "Heat +4.5", pickedSide: "AWAY", line: 4.5, status: "PUSH", units: 1, odds: -110 },
  { who: "C", ...NYK, gameTime: at("2026-11-06", 19), betType: "SPREAD", betDetail: "Heat +4.5", pickedSide: "AWAY", line: 4.5, status: "WIN", units: 1, odds: -110 },
  //   a different line is a different bet: +0.90909
  { who: "C", ...NYK, gameTime: at("2026-11-06", 19), betType: "SPREAD", betDetail: "Heat +5.5", pickedSide: "AWAY", line: 5.5, status: "WIN", units: 1, odds: -110 },
  //   odds 0 win pays 0; the PENDING copy is ignored
  { who: "A", ...NYK, gameTime: at("2026-11-06", 19), betType: "MONEYLINE", betDetail: "Knicks ML", pickedSide: "HOME", status: "WIN", units: 1, odds: 0 },
  { who: "B", ...NYK, gameTime: at("2026-11-06", 19), betType: "MONEYLINE", betDetail: "Knicks ML", pickedSide: "HOME", status: "PENDING", units: 1, odds: -110 },
  // 2026-11-08 11:30 PM ET (04:30 UTC on the 9th): stays on the 8th. (2 + 1) / 2 = 1.5; one copy ungraded-stamp.
  { who: "A", ...LAL, gameTime: at("2026-11-08", 23, 30), betType: "MONEYLINE", betDetail: "Celtics ML", pickedSide: "AWAY", status: "WIN", units: 1, odds: 200, graded: false },
  { who: "B", ...LAL, gameTime: at("2026-11-08", 23, 30), betType: "MONEYLINE", betDetail: "Celtics ML", pickedSide: "AWAY", status: "WIN", units: 1, odds: 100 },
  // 2026-11-10 (the window's last day): two copies of an under loss -> -1
  { who: "A", ...NYY, gameTime: at("2026-11-10", 13), betType: "TOTAL", betDetail: "Under 8.5", line: 8.5, status: "LOSS", units: 1, odds: -110 },
  { who: "B", ...NYY, gameTime: at("2026-11-10", 13), betType: "TOTAL", betDetail: "Under 8.5", line: 8.5, status: "LOSS", units: 1, odds: -110 },
  // 2026-11-03: before the window -> excluded
  { who: "A", ...NYY, gameTime: at("2026-11-03", 13), betType: "MONEYLINE", betDetail: "Yankees ML", pickedSide: "HOME", status: "LOSS", units: 5, odds: -110 },
  // another user's copy of the 11-05 ML -> excluded
  { who: "OTHER", ...LAL, gameTime: at("2026-11-05", 19), betType: "MONEYLINE", betDetail: "Lakers ML", pickedSide: "HOME", status: "WIN", units: 10, odds: -110 },
];

const HAND_UNIQUE: Record<string, number> = {
  "2026-11-05": -4 / 3 + 3,
  "2026-11-06": (100 / 110 + 2.4) / 2 + 100 / 110,
  "2026-11-08": 1.5,
  "2026-11-10": -1,
};

class Rollback extends Error {}

async function main() {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(".env");
    } catch {
      /* no .env */
    }
  }
  if (!isLocal(process.env.DATABASE_URL)) {
    console.log("SKIP: DATABASE_URL is not a local database - this test writes (rolled-back) fixtures.");
    return;
  }
  const { prisma } = await import("@/lib/prisma");
  const { getMomentumDaily } = await import("@/server/data/momentum-daily");

  try {
    await prisma.$transaction(
      async (tx) => {
        const user = await tx.user.create({ data: { supabaseId: PREFIX + "u", email: PREFIX + "u@example.test" }, select: { id: true } });
        const other = await tx.user.create({ data: { supabaseId: PREFIX + "o", email: PREFIX + "o@example.test" }, select: { id: true } });
        const s1 = await tx.sport.create({ data: { name: PREFIX + "S1" }, select: { id: true } });
        const s2 = await tx.sport.create({ data: { name: PREFIX + "S2" }, select: { id: true } });
        const capper = async (userId: string, name: string) =>
          (await tx.capper.create({ data: { userId, name: PREFIX + name, source: "TWITTER" }, select: { id: true } })).id;
        const cappers = { A: await capper(user.id, "A"), B: await capper(user.id, "B"), C: await capper(user.id, "C"), OTHER: await capper(other.id, "O") };
        const sports = { S1: s1.id, S2: s2.id };

        type Row = UniqueMomentumPick & { userId: string; capperId: string; sportId: string; day: string };
        const rows: Row[] = [];
        for (const [i, f] of FIXTURES.entries()) {
          const keyed = withUniqueKey({
            homeTeam: f.homeTeam,
            awayTeam: f.awayTeam,
            gameTime: f.gameTime,
            betType: f.betType,
            betDetail: f.betDetail,
            pickedSide: f.pickedSide ?? null,
            line: f.line ?? null,
          });
          const gradedAt = f.status === "PENDING" || f.graded === false ? null : new Date(f.gameTime.getTime() + 3 * 3600000 + i * MIN);
          const userId = f.who === "OTHER" ? other.id : user.id;
          const capperId = cappers[f.who];
          const sportId = sports[f.sport ?? "S1"];
          const data = { ...keyed, userId, capperId, sportId, status: f.status, units: f.units, odds: f.odds, gradedAt } as Prisma.PickUncheckedCreateInput;
          const created = await tx.pick.create({ data, select: { id: true, uniqueKey: true } });
          check(`fixture ${i} stored a uniqueKey`, created.uniqueKey === keyed.uniqueKey);
          rows.push({
            id: created.id,
            homeTeam: f.homeTeam,
            awayTeam: f.awayTeam,
            gameTime: f.gameTime,
            gameNumber: null,
            betType: f.betType,
            period: "FULL_GAME",
            betDetail: f.betDetail,
            pickedSide: f.pickedSide ?? null,
            category: null,
            line: f.line ?? null,
            propMarket: null,
            playerName: null,
            status: f.status,
            units: f.units,
            odds: f.odds,
            gradedAt,
            userId,
            capperId,
            sportId,
            day: easternDateKey(f.gameTime),
          });
        }
        check("11:30 PM ET fixture is keyed to its Eastern day", rows[15].day === "2026-11-08", rows[15].day);

        const window = new Set(["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"]);
        const settled = new Set(["WIN", "LOSS", "PUSH"]);
        // The Today view's rule, day by day, over the same picks the SQL sees (user + window + filters).
        const tsUnique = (keep: (r: Row) => boolean): Map<string, number> => {
          const byDay = new Map<string, Row[]>();
          for (const r of rows) {
            if (r.userId !== user.id || !window.has(r.day) || !keep(r)) continue;
            const list = byDay.get(r.day) ?? [];
            list.push(r);
            byDay.set(r.day, list);
          }
          const out = new Map<string, number>();
          byDay.forEach((list, day) => {
            if (!list.some((r) => settled.has(r.status))) return;
            const u = uniqueMomentumEvents(list);
            out.set(day, u.events.reduce((a, e) => a + e.d, 0) + u.unstamped);
          });
          return out;
        };
        const tsAll = (): Map<string, number> => {
          const out = new Map<string, number>();
          for (const r of rows) {
            if (r.userId !== user.id || !window.has(r.day) || (r.status !== "WIN" && r.status !== "LOSS")) continue;
            const d = r.status === "WIN" ? winUnits(r.units, r.odds) : -r.units;
            out.set(r.day, (out.get(r.day) ?? 0) + d);
          }
          return out;
        };
        const same = (label: string, sql: DailyNet[], ts: Map<string, number>) => {
          const sqlMap = new Map(sql.map((r) => [r.day, r.net]));
          const days = new Set([...sqlMap.keys(), ...ts.keys()]);
          let ok = true;
          days.forEach((d) => {
            if (!close(sqlMap.get(d) ?? 0, ts.get(d) ?? 0)) ok = false;
          });
          check(label, ok && days.size > 0, "sql=" + JSON.stringify([...sqlMap]) + " ts=" + JSON.stringify([...ts]));
        };

        const unique = await getMomentumDaily(user.id, "7D", END_KEY, {}, { unique: true, db: tx });
        same("unique, no filters: SQL == uniqueMomentumEvents per day", unique, tsUnique(() => true));
        const got = new Map(unique.map((r) => [r.day, r.net]));
        for (const [day, net] of Object.entries(HAND_UNIQUE)) check(`unique ${day} = ${net.toFixed(4)}u (hand-worked)`, close(got.get(day) ?? NaN, net), String(got.get(day)));
        check("unique: no row for the out-of-window day", !got.has("2026-11-03"));
        check("unique: exactly the four fixture days", unique.length === 4, JSON.stringify(unique.map((r) => r.day)));

        const filtered: [string, { capperId?: string; sportId?: string; status?: string }, (r: Row) => boolean][] = [
          ["capper A", { capperId: cappers.A }, (r) => r.capperId === cappers.A],
          ["sport S2", { sportId: sports.S2 }, (r) => r.sportId === sports.S2],
          ["result LOSS", { status: "LOSS" }, (r) => r.status === "LOSS"],
          ["result WIN", { status: "WIN" }, (r) => r.status === "WIN"],
        ];
        for (const [name, f, keep] of filtered) {
          same(`unique, ${name}: SQL == uniqueMomentumEvents per day`, await getMomentumDaily(user.id, "7D", END_KEY, f, { unique: true, db: tx }), tsUnique(keep));
        }

        const all = await getMomentumDaily(user.id, "7D", END_KEY, {}, { db: tx });
        same("All mode unchanged: plain per-day sum", all, tsAll());
        check("All 2026-11-05 = -4 + 3 = -1u (duplicates counted)", close(new Map(all.map((r) => [r.day, r.net])).get("2026-11-05") ?? NaN, -1));

        throw new Rollback();
      },
      { timeout: 60000 }
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const left = await prisma.user.count({ where: { supabaseId: { startsWith: PREFIX } } });
  check("rolled back: no fixture user left", left === 0, String(left));
  await prisma.$disconnect();
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
