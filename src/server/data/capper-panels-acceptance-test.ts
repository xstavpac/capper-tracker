// The /dashboard panels statement (capper-panels.ts): Hot Hand, Coldest, Rising Fast, Falling off,
// Best / Worst last 20.
//
//   1. Rising Fast and Falling off against a plain-JS re-derivation from the raw pick rows (no SQL
//      shared with the implementation), plus the rules spelled out: Falling off is Rising Fast's
//      mirror, a score that rounds to 0 points is in neither, a short baseline is in neither.
//   2. Best / Worst last 20 against a re-derivation: the 14-day activity gate, the 10-pick minimum,
//      pushes in the denominator, the 50% split (nobody in both), five rows at most.
//   3. Hot Hand / Coldest ARE the /cappers panels: equal to getPanelRows at "This week".
//   4. Test cappers appear nowhere; the whole thing is one statement; cache keys.
//
// DB-backed and WRITING: creates its own users/cappers/picks (ids prefixed `__PanelsCache__`) and
// deletes them by exact id at the end. Refuses to run unless DATABASE_URL points at localhost. Run
// against a disposable local Postgres with migrations applied:
//   npx tsx --env-file=.env src/server/data/capper-panels-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { computeCapperPanels, getCapperPanels, capperPanelsCacheKey, ACTIVITY_WINDOW_DAYS, type BestLast20Entry } from "@/server/data/capper-panels";
import { getPanelRows } from "@/server/data/cappers-page-aggregates";
import { risingSeries, type RisingEntry } from "@/lib/cappers-panels";
import { cacheKeys } from "@/lib/cache-keys";

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostOf(process.env.DATABASE_URL))) {
  console.log("SKIP: DATABASE_URL is not a local database - this test writes fixtures and only runs against localhost/127.0.0.1.");
  process.exit(0);
}

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
function same(label: string, got: unknown, want: unknown) {
  check(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} !== ${JSON.stringify(want)}`);
}

const PREFIX = "__PanelsCache__";
const T0 = Date.now();
const HOUR = 3600000;
const DAY = 24 * HOUR;
const W = "WIN" as const;
const L = "LOSS" as const;
const P = "PUSH" as const;
type Result = typeof W | typeof L | typeof P;
type Row = Prisma.PickCreateManyInput;

let seq = 0;
// `results` is oldest -> newest: one pick an hour, the newest an hour ago, graded three hours after
// its game. So "newest by game" and "most recently graded" are the same order here.
function picksFor(userId: string, capperId: string, sportId: string, results: Result[], opts: { postedAgoDays?: number } = {}): Row[] {
  return results.map((status, i) => {
    seq++;
    const gameTime = new Date(T0 - (results.length - i) * HOUR - 4 * HOUR);
    return {
      id: `${PREFIX}pick-${String(seq).padStart(5, "0")}`,
      userId,
      capperId,
      sportId,
      homeTeam: "Home",
      awayTeam: "Away",
      betType: "MONEYLINE",
      betDetail: null,
      odds: -110,
      line: null,
      period: "FULL_GAME",
      units: 1,
      datePosted: new Date(T0 - (opts.postedAgoDays ?? 1) * DAY - i * 1000),
      gameTime,
      status,
      gradedAt: new Date(gameTime.getTime() + 3 * HOUR),
      createdAt: new Date(T0 - seq * 1000),
    };
  });
}

// n picks with exactly `wins` wins, spread evenly (never a long run at either end).
function spread(n: number, wins: number): Result[] {
  return Array.from({ length: n }, (_, i) => (Math.floor(((i + 1) * wins) / n) > Math.floor((i * wins) / n) ? W : L));
}
// `wins` wins out of 10 with the losses first, so nobody is on a 3+ win streak by accident... unless
// they won them all; the streak panels are checked against getPanelRows either way.
const recent = (wins: number): Result[] => [...Array(10 - wins).fill(L), ...Array(wins).fill(W)];

// ---- plain-JS references ------------------------------------------------------------------------
type RawPick = { id: string; capperId: string; status: string; gameTime: Date; gradedAt: Date | null; createdAt: Date; datePosted: Date };
const desc = (a: [number, number, string], b: [number, number, string]) => b[0] - a[0] || b[1] - a[1] || (a[2] < b[2] ? 1 : -1);
// Half away from zero, like SQL round(numeric).
const roundAway = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

function trendReference(cappers: { id: string; name: string; isTest: boolean }[], picks: RawPick[]) {
  const rows = cappers
    .filter((c) => !c.isTest)
    .flatMap((c) => {
      const decided = picks
        .filter((p) => p.capperId === c.id && (p.status === "WIN" || p.status === "LOSS"))
        .sort((a, b) => desc([a.gameTime.getTime(), a.createdAt.getTime(), a.id], [b.gameTime.getTime(), b.createdAt.getTime(), b.id]))
        .slice(0, 100);
      const rec = decided.slice(0, 10);
      const base = decided.slice(10);
      if (rec.length < 10 || base.length < 30) return [];
      const rw = rec.filter((p) => p.status === "WIN").length;
      const bw = base.filter((p) => p.status === "WIN").length;
      const score = rw / 10 - bw / base.length;
      return [{ id: c.id, name: c.name, bn: base.length, score, pts: roundAway(Number((score * 100).toFixed(7))), results: rec.map((p) => p.status === "WIN").reverse(), baseline: bw / base.length }];
    });
  const tie = (a: (typeof rows)[number], b: (typeof rows)[number]) => b.bn - a.bn || (a.id < b.id ? -1 : 1);
  return {
    rising: rows.filter((r) => r.pts >= 1).sort((a, b) => b.score - a.score || tie(a, b)).slice(0, 5),
    falling: rows.filter((r) => r.pts <= -1).sort((a, b) => a.score - b.score || tie(a, b)).slice(0, 5),
  };
}
const trendLine = (rows: { name: string; pts: number }[]) => rows.map((r) => r.name + " " + r.pts);
function sameTrend(label: string, got: RisingEntry[], want: ReturnType<typeof trendReference>["rising"]) {
  same(label + ": cappers and points, in order", trendLine(got), trendLine(want));
  same(label + ": the last 10 results, oldest first", got.map((r) => r.results), want.map((r) => r.results));
  check(label + ": baseline win rate", got.length === want.length && got.every((r, i) => Math.abs(r.baseline - want[i].baseline) < 1e-8));
}

function last20Reference(cappers: { id: string; name: string; isTest: boolean }[], picks: RawPick[], now: number) {
  const pool = cappers
    .filter((c) => !c.isTest)
    .flatMap((c) => {
      const mine = picks.filter((p) => p.capperId === c.id);
      if (!mine.some((p) => p.datePosted.getTime() >= now - ACTIVITY_WINDOW_DAYS * DAY)) return [];
      const last = mine
        .filter((p) => ["WIN", "LOSS", "PUSH"].includes(p.status))
        .sort((a, b) => desc([a.gradedAt?.getTime() ?? 0, a.createdAt.getTime(), a.id], [b.gradedAt?.getTime() ?? 0, b.createdAt.getTime(), b.id]))
        .slice(0, 20);
      if (last.length < 10) return [];
      const wins = last.filter((p) => p.status === "WIN").length;
      const losses = last.filter((p) => p.status === "LOSS").length;
      const pct = Math.round((wins / last.length) * 10000) / 100;
      return [{ name: c.name, rec: `${wins}-${losses}-${last.length - wins - losses}`, pct, score: Math.round(((last.length * pct + 10 * 52.4) / (last.length + 10)) * 100) / 100 }];
    });
  const name = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1);
  return {
    best: pool.filter((e) => e.pct >= 50).sort((a, b) => b.score - a.score || name(a, b)).slice(0, 5),
    worst: pool.filter((e) => e.pct < 50).sort((a, b) => a.score - b.score || name(a, b)).slice(0, 5),
  };
}
const last20Line = (rows: BestLast20Entry[]) => rows.map((e) => `${e.name} ${e.wins}-${e.losses}-${e.pushes} ${e.recentWinPct}`);

async function main() {
  const userId = `${PREFIX}user`;
  const emptyUser = `${PREFIX}user-empty`;
  await prisma.user.create({ data: { id: userId, supabaseId: `${PREFIX}sb`, email: `${PREFIX}u@example.invalid` } });
  await prisma.user.create({ data: { id: emptyUser, supabaseId: `${PREFIX}sb-empty`, email: `${PREFIX}e@example.invalid` } });

  let createdSportId: string | null = null;
  const existing = await prisma.sport.findUnique({ where: { name: "MLB" } });
  const sportId = existing?.id ?? (createdSportId = (await prisma.sport.create({ data: { name: "MLB" } })).id);

  // key -> [name, picks oldest -> newest, options]
  const fixture: Record<string, { name: string; results: Result[]; isTest?: boolean; postedAgoDays?: number }> = {
    // Trend: a 40-pick 50% baseline, then the last 10.
    riser: { name: "Riser", results: [...spread(40, 20), ...recent(8)] }, // +30
    riser2: { name: "Riser small", results: [...spread(40, 20), ...recent(6)] }, // +10
    f0: { name: "Faller 0", results: [...spread(40, 20), ...recent(0)] }, // -50
    f1: { name: "Faller 1", results: [...spread(40, 20), ...recent(1)] }, // -40
    f2: { name: "Faller 2", results: [...spread(40, 20), ...recent(2)] }, // -30
    f3: { name: "Faller 3", results: [...spread(40, 20), ...recent(3)] }, // -20
    f4: { name: "Faller 4", results: [...spread(40, 20), ...recent(4)] }, // -10: the sixth faller, off the list
    // -50 too, but on a 30-pick baseline: ties with Faller 0 on score, loses on baseline size.
    deep: { name: "Deep faller", results: [...spread(30, 18), ...recent(1)] },
    flat: { name: "Flat", results: [...spread(40, 20), ...recent(5)] }, // exactly on their norm
    // 3 of 10 against 26 of 87 (29.885%): +0.115 points, which rounds to 0 - in neither panel.
    hair: { name: "Hair", results: [...spread(87, 26), ...recent(3)] },
    // A great last 10 on a 29-pick baseline: one short.
    short: { name: "Short base", results: [...spread(29, 10), ...recent(9)] },
    // A test capper falling hard, on a hot streak's opposite: must appear nowhere.
    test: { name: "Test Tess", results: [...spread(40, 30), ...recent(0)], isTest: true },
    // Streaks (too few picks for a trend).
    hot: { name: "Hot five", results: [L, W, W, W, W, W] },
    cold: { name: "Cold four", results: [W, W, L, L, L, L] },
    // Last 20 only.
    push: { name: "Pushy", results: [W, L, P, W, L, W, L, P, W, L, W, L, P, W, L, W, L, P, W, L] }, // 8-8-4: 40%, pushes count
    nine: { name: "Nine decided", results: [L, L, L, L, L, L, L, W, L] }, // one short of the minimum
    idle: { name: "Idle Ivan", results: [L, L, L, W, L, L, L, W, L, L, L, W, L, L], postedAgoDays: 30 }, // nothing posted in 14 days
  };
  const capperId = (k: string) => `${PREFIX}c-${k}`;
  for (const [k, c] of Object.entries(fixture)) {
    await prisma.capper.create({ data: { id: capperId(k), userId, name: c.name, source: "OTHER", isTest: c.isTest ?? false } });
  }
  await prisma.pick.createMany({ data: Object.entries(fixture).flatMap(([k, c]) => picksFor(userId, capperId(k), sportId, c.results, { postedAgoDays: c.postedAgoDays })) });

  // Count the statements the panels issue.
  const original = prisma.$queryRaw.bind(prisma);
  let statements = 0;
  (prisma as unknown as { $queryRaw: unknown }).$queryRaw = (...a: unknown[]) => {
    statements++;
    return (original as (...x: unknown[]) => unknown)(...a);
  };

  try {
    const now = new Date();
    const panels = await computeCapperPanels(userId, now);
    const oneStatement = statements;
    (prisma as unknown as { $queryRaw: unknown }).$queryRaw = original;
    same("the six panels come from ONE statement", oneStatement, 1);

    const cappers = (await prisma.capper.findMany({ where: { userId }, select: { id: true, name: true, isTest: true } })) as { id: string; name: string; isTest: boolean }[];
    const picks = (await prisma.pick.findMany({ where: { userId }, select: { id: true, capperId: true, status: true, gameTime: true, gradedAt: true, createdAt: true, datePosted: true } })) as RawPick[];

    // 1. Rising Fast / Falling off.
    const ref = trendReference(cappers, picks);
    sameTrend("rising == re-derivation from the raw picks", panels.rising, ref.rising);
    sameTrend("falling == re-derivation from the raw picks", panels.falling, ref.falling);
    same("rising: best first", trendLine(panels.rising), ["Riser 30", "Riser small 10"]);
    same(
      "falling: most negative first, a tie going to the larger baseline, five at most (the sixth faller is cut)",
      trendLine(panels.falling),
      ["Faller 0 -50", "Deep faller -50", "Faller 1 -40", "Faller 2 -30", "Faller 3 -20"]
    );
    check("falling: every score is negative, every rising score positive", panels.falling.every((r) => r.pts <= -1) && panels.rising.every((r) => r.pts >= 1));
    check(
      "falling: the chart line starts at 0 and ends on the (negative) score, like Rising Fast's",
      [...panels.falling, ...panels.rising].every((r) => {
        const line = risingSeries(r.results, r.baseline);
        return line[0] === 0 && Math.round(line[line.length - 1]) === r.pts;
      })
    );
    const trendNames = new Set([...panels.rising, ...panels.falling].map((r) => r.name));
    check("a score that rounds to 0 points is in neither panel (no +0 / -0 pts)", !trendNames.has("Hair") && ref.rising.every((r) => r.name !== "Hair"));
    check("exactly on their norm: in neither panel", !trendNames.has("Flat"));
    check("a 29-pick baseline is one short: in neither panel", !trendNames.has("Short base"));
    check("nobody is in both Rising Fast and Falling off", panels.rising.every((r) => !panels.falling.some((f) => f.capperId === r.capperId)));

    // 2. Best / Worst last 20.
    const l20 = last20Reference(cappers, picks, now.getTime());
    same("best last 20 == re-derivation", last20Line(panels.bestLast20), l20.best.map((e) => `${e.name} ${e.rec} ${e.pct}`));
    same("worst last 20 == re-derivation", last20Line(panels.worstLast20), l20.worst.map((e) => `${e.name} ${e.rec} ${e.pct}`));
    check("best is 50%+ only, worst under 50% only, five rows at most each", panels.bestLast20.length > 0 && panels.worstLast20.length > 0 && panels.bestLast20.every((e) => e.recentWinPct >= 50) && panels.worstLast20.every((e) => e.recentWinPct < 50) && panels.bestLast20.length <= 5 && panels.worstLast20.length <= 5);
    check("nobody is in both Best and Worst", panels.bestLast20.every((e) => !panels.worstLast20.some((x) => x.capperId === e.capperId)));
    check("exactly 50% counts as Best", l20.best.some((e) => e.pct === 50) === panels.bestLast20.some((e) => e.recentWinPct === 50) && [...l20.best, ...l20.worst].some((e) => e.name === "Flat"));
    const all20 = await computeAllLast20(userId, now);
    same("pushes count in the denominator: 8-8-4 is 40%", all20.find((e) => e.startsWith("Pushy")), "Pushy 8-8-4 40");
    check("nine decided picks is one short of the minimum; nothing posted in 14 days is inactive", !all20.some((e) => e.startsWith("Nine decided") || e.startsWith("Idle Ivan")));

    // 3. Hot Hand / Coldest are the /cappers panels.
    const [hot, cold] = await Promise.all([getPanelRows({ userId, panel: "hottest", window: "week", now }), getPanelRows({ userId, panel: "coldest", window: "week", now })]);
    same("hot hand == /cappers Hot Hand (This week), same rows in the same order", panels.hottest, hot);
    same("coldest == /cappers Coldest (This week), same rows in the same order", panels.coldest, cold);
    check("hot hand: the five-win streak is there; coldest: the four-loss one, with its units", panels.hottest.some((e) => e.name === "Hot five" && e.streak === 5) && panels.coldest.some((e) => e.name === "Cold four" && e.streak === 4 && e.units === -4), JSON.stringify([panels.hottest, panels.coldest]));

    // 4. Test cappers, the empty roster, the cache.
    const everyone = [...panels.hottest, ...panels.coldest, ...panels.rising, ...panels.falling, ...panels.bestLast20, ...panels.worstLast20, ...all20.map((s) => ({ name: s }))];
    check("the test capper appears in no panel", !everyone.some((e) => e.name.startsWith("Test Tess")));
    same("a user with no cappers: six empty panels", await computeCapperPanels(emptyUser), { hottest: [], coldest: [], rising: [], falling: [], bestLast20: [], worstLast20: [] });
    same("getCapperPanels (cachedByTag wrapper) == computeCapperPanels", await getCapperPanels(userId), await computeCapperPanels(userId));
    const keys = [capperPanelsCacheKey("u1"), capperPanelsCacheKey("u2")];
    check("cache keys are unique per user and never the dashboard tag", new Set(keys).size === 2 && !keys.includes(cacheKeys.dashboard("u1")) && !keys.includes(cacheKeys.dashboard("u2")));
  } finally {
    (prisma as unknown as { $queryRaw: unknown }).$queryRaw = original;
    for (const u of [userId, emptyUser]) {
      await prisma.pick.deleteMany({ where: { userId: u } });
      await prisma.capper.deleteMany({ where: { userId: u } });
      await prisma.user.deleteMany({ where: { id: u } });
    }
    if (createdSportId) await prisma.sport.deleteMany({ where: { id: createdSportId } });
  }
}

// Every capper in the last-20 pool (the panels keep five each), re-derived, as "name W-L-P pct".
async function computeAllLast20(userId: string, now: Date): Promise<string[]> {
  const cappers = (await prisma.capper.findMany({ where: { userId }, select: { id: true, name: true, isTest: true } })) as { id: string; name: string; isTest: boolean }[];
  const picks = (await prisma.pick.findMany({ where: { userId }, select: { id: true, capperId: true, status: true, gameTime: true, gradedAt: true, createdAt: true, datePosted: true } })) as RawPick[];
  // The reference keeps five per side, so run it one capper at a time.
  const each = cappers.flatMap((c) => {
    const one = last20Reference([c], picks, now.getTime());
    return [...one.best, ...one.worst];
  });
  return each.map((e) => `${e.name} ${e.rec} ${e.pct}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (failures > 0) process.exit(1);
    console.log("\nAll checks passed.");
  });
