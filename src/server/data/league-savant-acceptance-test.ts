// The /dashboard League Savant card's read (league-savant.ts, inside the one panels statement).
//
//   1. The score, against a plain-JS re-derivation from the raw pick rows (no SQL shared with the
//      implementation), and its rules spelled out: a 69-pick capper outranks a 4-0 one, ties, a
//      single capper, pushes, an empty league, ten rows at most, test cappers nowhere.
//   2. The season window: the feed's newest season (after an off-season, or after its preseason),
//      the 180-day fallback when the feed's history starts mid-season, a season with no final yet.
//   3. In-season leagues: from finals, from the odds snapshot, never a league without a recent game;
//      and every league with a decided pick when the feed names none.
//
// DB-backed and WRITING: creates its own user/cappers/picks, sports, game_results and
// odds_snapshots (ids, names and feed keys prefixed `__SavantTest__`) and deletes them by those exact
// keys at the end. The feed keys are its own, so no real league's games are read or touched. Refuses
// to run unless DATABASE_URL points at localhost. Run against a disposable local Postgres:
//   npx tsx --env-file=.env src/server/data/league-savant-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { computeCapperPanels } from "@/server/data/capper-panels";
import { easternDateKey, startOfEasternDay } from "@/lib/dates";
import { SAVANT_FALLBACK_DAYS, SAVANT_PANEL_COUNT, SAVANT_PRIOR_PICKS, type SavantLeague } from "@/lib/league-savant";

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

const PREFIX = "__SavantTest__";
const DAY = 86400000;
// Mid-afternoon Eastern, so "N days ago" is N Eastern calendar days ago whatever hour this runs at.
const NOW = new Date(startOfEasternDay(new Date()).getTime() + 15 * 3600000);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const W = "WIN" as const;
const L = "LOSS" as const;
const P = "PUSH" as const;
type Status = typeof W | typeof L | typeof P | "PENDING";

// The leagues, each with its own feed key.
//   main     last season, a long off-season, then a season that opened 40 days ago
//   pre      a preseason (flagged), then a regular season that opened 15 days ago
//   midway   the feed's history starts 20 days ago with nothing before it: where the season began is unknown
//   opening  last season only, and a game in the odds snapshot three days out
//   resting  last season only, and nothing coming
//   nofeed   a sport the feed does not know
const LEAGUES = ["main", "pre", "midway", "opening", "resting", "nofeed"] as const;
type LeagueKey = (typeof LEAGUES)[number];
const leagueName = (k: LeagueKey) => `${PREFIX}${k}`;
const feedKey = (k: LeagueKey) => `${PREFIX.toLowerCase()}${k}`;
const FEEDS = LEAGUES.filter((k) => k !== "nofeed").map((k) => ({ key: feedKey(k), label: leagueName(k) }));

let seq = 0;
const game = (k: LeagueKey, daysAgo: number, isPreseason = false): Prisma.GameResultCreateManyInput => ({
  id: `${PREFIX}game-${++seq}`,
  sportKey: feedKey(k),
  externalId: `${PREFIX}${seq}`,
  homeTeam: "Home",
  awayTeam: "Away",
  homeScore: 1,
  awayScore: 0,
  gameDate: ago(daysAgo),
  isPreseason,
});
const weekly = (k: LeagueKey, from: number, to: number, isPreseason = false) => Array.from({ length: Math.floor((from - to) / 7) + 1 }, (_, i) => game(k, from - i * 7, isPreseason));

type Spec = { status: Status; daysAgo: number; odds?: number; units?: number };
const reps = (n: number, status: Status, daysAgo: number, odds = 100): Spec[] => Array.from({ length: n }, () => ({ status, daysAgo, odds }));

// ---- plain-JS reference ---------------------------------------------------------------------------
type RawPick = { capperId: string; sportId: string; status: string; odds: number; units: number; gameTime: Date };
const roundAway = (x: number) => Math.sign(x) * Math.round(Math.abs(x));
function reference(cappers: { id: string; name: string; isTest: boolean }[], picks: RawPick[], sportId: string, start: Date) {
  const rows = cappers
    .filter((c) => !c.isTest)
    .flatMap((c) => {
      const mine = picks.filter((p) => p.capperId === c.id && p.sportId === sportId && p.gameTime >= start && [W, L, P].includes(p.status as never));
      const decided = mine.filter((p) => p.status !== P).length;
      if (decided === 0) return [];
      const net = (p: RawPick) => (p.status === W ? p.units * (p.odds > 0 ? p.odds / 100 : 100 / Math.abs(p.odds)) : p.status === L ? -p.units : 0);
      const units = mine.reduce((s, p) => s + net(p), 0);
      const recent = mine.filter((p) => p.gameTime.getTime() >= NOW.getTime() - 30 * DAY);
      return [{ name: c.name, decided, picks: mine.length, units, adj: Number((units / (decided + SAVANT_PRIOR_PICKS)).toFixed(9)), last30: recent.length > 0 ? recent.reduce((s, p) => s + net(p), 0) : null }];
    });
  return rows
    .map((r) => ({ ...r, score: roundAway(Number(((100 * (rows.filter((o) => o.adj < r.adj).length + rows.filter((o) => o.adj === r.adj).length / 2)) / rows.length).toFixed(6))) }))
    .sort((a, b) => b.adj - a.adj || b.decided - a.decided || (a.name < b.name ? -1 : 1));
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const line = (rows: { name: string; units: number; picks: number; score: number }[]) => rows.map((r) => `${r.name} ${r2(r.units)}u ${r.picks}p ${r.score}`);

async function cleanup(userId: string) {
  await prisma.pick.deleteMany({ where: { userId } });
  await prisma.capper.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.gameResult.deleteMany({ where: { sportKey: { in: LEAGUES.map(feedKey) } } });
  await prisma.oddsSnapshot.deleteMany({ where: { sportKey: { in: LEAGUES.map(feedKey) } } });
  await prisma.sport.deleteMany({ where: { name: { in: LEAGUES.map(leagueName) } } });
}

async function main() {
  const userId = `${PREFIX}user`;
  await cleanup(userId);
  await prisma.user.create({ data: { id: userId, supabaseId: `${PREFIX}sb`, email: `${PREFIX}u@example.invalid` } });
  const sportId = {} as Record<LeagueKey, string>;
  for (const k of LEAGUES) sportId[k] = (await prisma.sport.create({ data: { name: leagueName(k) } })).id;

  await prisma.gameResult.createMany({
    data: [
      ...weekly("main", 330, 200),
      ...weekly("main", 40, 1),
      ...weekly("pre", 30, 20, true),
      ...weekly("pre", 15, 1),
      ...weekly("midway", 20, 1),
      ...weekly("opening", 330, 200),
      ...weekly("resting", 330, 200),
    ],
  });
  const soon = new Date(NOW.getTime() + 3 * DAY).toISOString().slice(0, 19) + "Z";
  await prisma.oddsSnapshot.create({ data: { sportKey: feedKey("opening"), fetchDate: easternDateKey(NOW), data: [{ id: "g1", homeTeam: "Home", awayTeam: "Away", commenceTime: soon, bookmakers: [] }] } });
  // An old snapshot, and one whose only game is a month out: neither puts a league in season.
  await prisma.oddsSnapshot.create({ data: { sportKey: feedKey("resting"), fetchDate: easternDateKey(ago(40)), data: [{ id: "g2", commenceTime: soon }] } });
  await prisma.oddsSnapshot.create({ data: { sportKey: feedKey("resting"), fetchDate: easternDateKey(NOW), data: [{ id: "g3", commenceTime: new Date(NOW.getTime() + 30 * DAY).toISOString().slice(0, 19) + "Z" }, { id: "g4" }] } });

  // name -> picks per league. Odds +100 unless said, so a win is +1u and the sums are exact.
  const fixture: { name: string; isTest?: boolean; picks: Partial<Record<LeagueKey, Spec[]>> }[] = [
    // 45-24 at +100: +21u over 69 decided, adjusted 21/89 = 0.236.
    { name: "Volume", picks: { main: [...reps(45, W, 10), ...reps(24, L, 10)] } },
    // 4-0: +4u, adjusted 4/24 = 0.167. A better raw rate than Volume (1u a pick against 0.3u), ranked under it.
    { name: "Four Oh", picks: { main: reps(4, W, 5) } },
    // Two identical 2-1 records: the same adjusted value, the same score, in name order.
    { name: "Twin B", picks: { main: [...reps(2, W, 6), ...reps(1, L, 6)] } },
    { name: "Twin A", picks: { main: [...reps(2, W, 6), ...reps(1, L, 6)] } },
    // Both exactly break-even (adjusted 0): the same score, the one with more decided picks first.
    { name: "Even two", picks: { main: [...reps(1, W, 8), ...reps(1, L, 8)] } },
    { name: "Even four", picks: { main: [...reps(2, W, 8), ...reps(2, L, 8)] } },
    // One win and three pushes: 4 picks, +1u, ranked on 1 decided pick. A push in the last 30 days is a pick.
    { name: "Pushy", picks: { main: [...reps(1, W, 35), ...reps(3, P, 9)] } },
    // Pushes only: no decided pick, so not ranked at all.
    { name: "All pushes", picks: { main: reps(3, P, 9) } },
    // Nothing in the last 30 days. The win 60 days ago is before the season opened (40 days ago): not counted.
    { name: "Early", picks: { main: [...reps(2, L, 36), ...reps(5, W, 60)] } },
    // A -110 win (+0.909u) and a pending pick, which is not a pick yet.
    { name: "Juice", picks: { main: [{ status: W, daysAgo: 4, odds: -110 }, { status: "PENDING", daysAgo: 0 }] } },
    // A test capper with the best record in the league: appears nowhere.
    { name: "Test Tess", isTest: true, picks: { main: reps(30, W, 3) } },
    // The one capper in two leagues: a pick 25 days ago is in `pre`'s preseason (not counted) and inside `midway`'s 180 days.
    { name: "Solo", picks: { pre: [...reps(3, W, 10), ...reps(6, L, 25)], midway: [...reps(2, W, 10), ...reps(1, L, 170), ...reps(4, L, 190)] } },
    // Leagues that are not in season: only read when the feed names no league at all.
    { name: "Resting Rae", picks: { resting: reps(2, W, 10), nofeed: reps(3, W, 10) } },
    // `opening` has no final yet this season: nothing before today counts, so the league is empty.
    { name: "Last year", picks: { opening: reps(5, W, 20) } },
  ];
  // Twelve more in `pre`, each with one more win than the last: the card keeps ten, the score counts all.
  for (let i = 1; i <= 12; i++) fixture.push({ name: "Ladder " + String(i).padStart(2, "0"), picks: { pre: reps(i, W, 5) } });

  const rows: Prisma.PickCreateManyInput[] = [];
  for (const [i, c] of fixture.entries()) {
    const capperId = `${PREFIX}c-${i}`;
    await prisma.capper.create({ data: { id: capperId, userId, name: c.name, source: "OTHER", isTest: c.isTest ?? false } });
    for (const [k, specs] of Object.entries(c.picks) as [LeagueKey, Spec[]][]) {
      for (const s of specs) {
        rows.push({ id: `${PREFIX}pick-${++seq}`, userId, capperId, sportId: sportId[k], homeTeam: "Home", awayTeam: "Away", betType: "MONEYLINE", odds: s.odds ?? 100, units: s.units ?? 1, gameTime: ago(s.daysAgo), status: s.status });
      }
    }
  }
  await prisma.pick.createMany({ data: rows });

  try {
    const { savant } = await computeCapperPanels(userId, NOW, FEEDS);
    const league = (k: LeagueKey): SavantLeague | undefined => savant.leagues.find((l) => l.league === leagueName(k));
    const cappers = (await prisma.capper.findMany({ where: { userId }, select: { id: true, name: true, isTest: true } })) as { id: string; name: string; isTest: boolean }[];
    const picks = (await prisma.pick.findMany({ where: { userId }, select: { capperId: true, sportId: true, status: true, odds: true, units: true, gameTime: true } })) as RawPick[];
    const dayStart = (daysAgo: number) => startOfEasternDay(ago(daysAgo));

    // 3. In-season leagues.
    same("in season: a final in the last week (three leagues) or a game in the odds snapshot (one), alphabetical", savant.leagues.map((l) => l.league), ["main", "midway", "opening", "pre"].map((k) => leagueName(k as LeagueKey)));
    check("the list came from the feed", savant.fromFeed);
    check("not in season: last season only (an old snapshot and a game a month out do not count), and a sport the feed does not know", !league("resting") && !league("nofeed"));

    // 2. The season window.
    same("main: the season is the feed's newest one, from its first game day (Eastern midnight)", [league("main")?.seasonSource, league("main")?.seasonStart], ["feed", dayStart(40).toISOString()]);
    same("pre: the regular season starts after its preseason games", [league("pre")?.seasonSource, league("pre")?.seasonStart], ["feed", dayStart(15).toISOString()]);
    same("midway: nothing before the feed's first game, so the window falls back to 180 days", [league("midway")?.seasonSource, league("midway")?.seasonStart], ["fallback", dayStart(SAVANT_FALLBACK_DAYS).toISOString()]);
    same("opening: last season's finals only, so this season opens today", [league("opening")?.seasonSource, league("opening")?.seasonStart], ["upcoming", startOfEasternDay(NOW).toISOString()]);

    // 1. The score.
    const main = league("main")?.rows ?? [];
    const refMain = reference(cappers, picks, sportId.main, dayStart(40));
    same("main == re-derivation from the raw picks: order, units, picks and score", line(main), line(refMain));
    same("main: last-30-day units == re-derivation (null when there is no pick in them)", main.map((r) => r.last30Units), refMain.map((r) => (r.last30 === null ? null : r2(r.last30))));
    const at = (name: string) => main.findIndex((r) => r.name === name);
    const row = (name: string) => main[at(name)];
    check("the 69-pick capper ranks above the 4-0 capper, with the higher score", at("Volume") === 0 && at("Four Oh") === 1 && row("Volume").score > row("Four Oh").score, JSON.stringify(line(main)));
    same("their real units and pick counts are what is shown", [row("Volume").units, row("Volume").picks, row("Four Oh").units, row("Four Oh").picks], [21, 69, 4, 4]);
    check("a tie: the same score, in name order", row("Twin A").score === row("Twin B").score && at("Twin A") + 1 === at("Twin B"));
    check("a tie on the adjusted value alone: the same score, more decided picks first", row("Even four").score === row("Even two").score && at("Even four") + 1 === at("Even two"));
    same("pushes count as picks and add 0 units", [row("Pushy").picks, row("Pushy").units], [4, 1]);
    same("a push in the last 30 days is a pick there, worth 0 units", row("Pushy").last30Units, 0);
    check("a capper with pushes only has no decided pick: not ranked", at("All pushes") === -1);
    same("picks before the season opened are not counted; no pick in the last 30 days", [row("Early").picks, row("Early").units, row("Early").last30Units], [2, -2, null]);
    same("a pending pick is not a pick; a -110 win is +0.91u", [row("Juice").picks, row("Juice").units], [1, 0.91]);
    check("the test capper appears in no league", savant.leagues.every((l) => l.rows.every((r) => r.name !== "Test Tess")));
    check("every score is a whole number from 0 to 100", savant.leagues.every((l) => l.rows.every((r) => Number.isInteger(r.score) && r.score >= 0 && r.score <= 100)));
    // Nine ranked cappers, no ties at the ends: the best is above eight and level with itself.
    same("the best of nine scores round(100 * 8.5 / 9), the worst round(100 * 0.5 / 9)", [main[0].score, main[main.length - 1].score, main.length], [94, 6, 9]);

    same("a single capper: level with itself, so 50", line(league("midway")?.rows ?? []), [`Solo 1u 3p 50`]);
    same("an empty league is still offered, with no rows", league("opening")?.rows, []);

    const pre = league("pre")?.rows ?? [];
    const refPre = reference(cappers, picks, sportId.pre, dayStart(15));
    same("pre == re-derivation, cut to the top ten", line(pre), line(refPre.slice(0, SAVANT_PANEL_COUNT)));
    check("ten rows at most, and the score counts every ranked capper (13 here), not the ten shown", pre.length === SAVANT_PANEL_COUNT && refPre.length === 13 && pre[0].score === 96, JSON.stringify(line(pre)));
    check("a preseason pick is outside the season: Solo's six losses are not counted", refPre.find((r) => r.name === "Solo")?.picks === 3);

    // The feed names no league: every league with a decided pick this season (the last 180 days).
    const bare = (await computeCapperPanels(userId, NOW, [])).savant;
    check("no feed: the list is not from the feed", !bare.fromFeed);
    same("no feed: every league with a decided pick in its window, alphabetical", bare.leagues.map((l) => l.league), ["main", "midway", "nofeed", "opening", "pre", "resting"].map((k) => leagueName(k as LeagueKey)));
    check("no feed: each is on the 180-day window", bare.leagues.every((l) => l.seasonSource === "fallback"));
    same("no feed: a league's rows are ranked the same way", line(bare.leagues.find((l) => l.league === leagueName("nofeed"))?.rows ?? []), ["Resting Rae 3u 3p 50"]);
  } finally {
    await cleanup(userId);
  }
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
