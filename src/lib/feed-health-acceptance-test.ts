// Feed health (ops console): the status rules in lib/feed-health.ts - In
// season / Off season / ⚠ Check feed - and the per-league thresholds,
// backtested against real stored schedules.
//
// REAL below is prod game_results, finals per ET day (preseason included, as
// stored), 2026-06-01 .. 2026-11-24 - read once with an aggregate query, no
// rows. It holds the MLB All-Star break, MLB's postseason tail and season end,
// the NFL / NCAAF weekly rhythm, the WNBA's FIBA World Cup break and its season
// end. Breaks that aren't in that window (NBA / NHL All-Star, the NFL's
// pre-Super Bowl gap, the CFP semis -> title gap) are built from their real
// shapes below.
//
// Pure, no DB. Run with:
//   npx tsx src/lib/feed-health-acceptance-test.ts
import {
  FEED_HEALTH_LEAGUES,
  FEED_THRESHOLDS,
  SYNC_STALE_HOURS,
  emptyLeague,
  feedHealth,
  feedHealthAlert,
  leagueFeedStatus,
  type FeedStatus,
  type FeedSyncRow,
  type LeagueFeedData,
} from "@/lib/feed-health";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NFL = "americanfootball_nfl";
const NCAAF = "americanfootball_ncaaf";
const NBA = "basketball_nba";
const NCAAB = "basketball_ncaab";
const NHL = "icehockey_nhl";
const MLB = "baseball_mlb";
const WNBA = "basketball_wnba";
// The Odds API lists ~a week ahead for football; for the daily leagues the
// snapshot holds only the current ET day's slate (prod, 2026-11-21..24).
const POSTED_WEEK = new Set([NFL, NCAAF]);

const REAL: Record<string, string> = {
  [NCAAF]:
    "2026-08-29:3 2026-08-30:5 2026-09-04:11 2026-09-05:39 2026-09-06:37 2026-09-07:3 2026-09-08:1 2026-09-11:1 2026-09-12:41 2026-09-13:44 2026-09-18:1 2026-09-19:20 2026-09-20:17 2026-09-25:1 2026-09-26:35 2026-09-27:35 2026-10-02:2 2026-10-03:32 2026-10-04:25 2026-10-07:1 2026-10-08:2 2026-10-09:5 2026-10-10:69 2026-10-11:31 2026-10-14:2 2026-10-15:2 2026-10-16:3 2026-10-17:70 2026-10-18:41 2026-10-21:3 2026-10-22:1 2026-10-23:3 2026-10-24:74 2026-10-25:30 2026-10-28:2 2026-10-29:2 2026-10-30:3 2026-10-31:79 2026-11-01:29 2026-11-04:2 2026-11-05:3 2026-11-06:3 2026-11-07:47 2026-11-08:69 2026-11-11:3 2026-11-12:3 2026-11-13:2 2026-11-14:47 2026-11-15:75 2026-11-18:3 2026-11-19:2 2026-11-20:3 2026-11-21:52 2026-11-22:70",
  // Regular season only - the preseason rows (Aug) are isPreseason and the
  // reader excludes them.
  [NFL]:
    "2026-09-10:1 2026-09-11:1 2026-09-13:8 2026-09-14:5 2026-09-15:1 2026-09-18:1 2026-09-20:8 2026-09-21:6 2026-09-22:1 2026-09-25:1 2026-09-27:9 2026-09-28:5 2026-09-29:1 2026-10-02:1 2026-10-04:9 2026-10-05:5 2026-10-06:1 2026-10-09:1 2026-10-11:9 2026-10-12:4 2026-10-13:1 2026-10-16:1 2026-10-18:8 2026-10-19:4 2026-10-20:1 2026-10-23:1 2026-10-25:8 2026-10-26:4 2026-10-27:1 2026-10-30:1 2026-11-01:8 2026-11-02:4 2026-11-03:1 2026-11-06:1 2026-11-08:8 2026-11-09:5 2026-11-10:1 2026-11-13:1 2026-11-15:8 2026-11-16:4 2026-11-17:1 2026-11-20:1 2026-11-22:7 2026-11-23:4 2026-11-24:1",
  [MLB]:
    "2026-06-01:9 2026-06-02:15 2026-06-04:9 2026-06-05:15 2026-06-06:14 2026-06-07:15 2026-06-08:8 2026-06-09:15 2026-06-10:15 2026-06-11:7 2026-06-12:15 2026-06-13:15 2026-06-14:14 2026-06-15:10 2026-06-16:15 2026-06-17:15 2026-06-18:8 2026-06-19:14 2026-06-20:14 2026-06-21:14 2026-06-22:12 2026-06-23:15 2026-06-24:16 2026-06-25:8 2026-06-26:14 2026-06-27:15 2026-06-28:15 2026-06-29:13 2026-06-30:15 2026-07-01:14 2026-07-02:9 2026-07-03:12 2026-07-04:15 2026-07-05:14 2026-07-06:7 2026-07-07:16 2026-07-08:15 2026-07-09:13 2026-07-10:14 2026-07-16:1 2026-07-17:14 2026-07-18:15 2026-07-19:16 2026-07-20:15 2026-07-21:13 2026-07-22:17 2026-07-23:5 2026-07-24:15 2026-07-25:15 2026-07-26:15 2026-07-27:11 2026-07-29:16 2026-07-30:10 2026-07-31:15 2026-08-01:15 2026-08-03:8 2026-08-04:15 2026-08-05:6 2026-08-06:16 2026-08-07:13 2026-08-08:16 2026-08-09:26 2026-08-10:10 2026-08-11:10 2026-08-12:20 2026-08-13:15 2026-08-14:5 2026-08-15:16 2026-08-16:22 2026-08-17:6 2026-08-18:10 2026-08-19:19 2026-08-20:17 2026-08-21:3 2026-08-22:17 2026-08-23:23 2026-08-24:5 2026-08-25:10 2026-08-26:18 2026-08-27:14 2026-08-28:6 2026-08-29:20 2026-08-30:22 2026-08-31:3 2026-09-01:12 2026-09-02:20 2026-09-03:13 2026-09-04:7 2026-09-05:15 2026-09-06:26 2026-09-07:11 2026-09-08:4 2026-09-09:18 2026-09-10:14 2026-09-11:4 2026-09-12:18 2026-09-13:23 2026-09-14:3 2026-09-15:10 2026-09-16:19 2026-09-17:15 2026-09-18:5 2026-09-19:16 2026-09-20:24 2026-09-21:5 2026-09-22:4 2026-09-23:17 2026-09-24:18 2026-09-25:8 2026-09-26:19 2026-09-27:25 2026-09-29:1 2026-09-30:4 2026-10-01:3 2026-10-02:1 2026-10-03:1 2026-10-04:3 2026-10-05:2 2026-10-06:2 2026-10-07:2 2026-10-08:4 2026-10-09:1 2026-10-11:1 2026-10-12:1 2026-10-13:2 2026-10-14:1 2026-10-15:2 2026-10-16:1 2026-10-18:1 2026-10-19:1 2026-10-20:1 2026-10-24:1 2026-10-25:1 2026-10-27:1 2026-10-28:1 2026-10-29:1",
  [NBA]:
    "2026-10-04:1 2026-10-05:2 2026-10-06:5 2026-10-07:4 2026-10-08:5 2026-10-09:7 2026-10-10:1 2026-10-11:8 2026-10-12:3 2026-10-13:5 2026-10-14:5 2026-10-15:7 2026-10-16:2 2026-10-17:12 2026-10-20:1 2026-10-21:2 2026-10-22:11 2026-10-23:2 2026-10-24:12 2026-10-25:8 2026-10-26:7 2026-10-27:9 2026-10-28:4 2026-10-29:12 2026-10-30:3 2026-10-31:11 2026-11-01:6 2026-11-02:4 2026-11-03:15 2026-11-05:14 2026-11-06:2 2026-11-07:9 2026-11-08:7 2026-11-09:7 2026-11-10:8 2026-11-11:6 2026-11-12:10 2026-11-13:4 2026-11-14:9 2026-11-15:6 2026-11-16:8 2026-11-17:8 2026-11-18:5 2026-11-19:12 2026-11-20:4 2026-11-21:10 2026-11-22:5 2026-11-23:7 2026-11-24:10",
  [NCAAB]:
    "2026-11-03:1 2026-11-04:17 2026-11-05:9 2026-11-06:31 2026-11-07:33 2026-11-08:28 2026-11-09:14 2026-11-10:25 2026-11-11:37 2026-11-12:31 2026-11-13:22 2026-11-14:40 2026-11-15:29 2026-11-16:14 2026-11-17:21 2026-11-18:27 2026-11-19:30 2026-11-20:29 2026-11-21:38 2026-11-22:18 2026-11-23:21 2026-11-24:18",
  [WNBA]:
    "2026-08-07:3 2026-08-08:5 2026-08-09:4 2026-08-10:1 2026-08-11:2 2026-08-12:3 2026-08-13:3 2026-08-14:3 2026-08-15:3 2026-08-16:2 2026-08-17:3 2026-08-18:1 2026-08-19:4 2026-08-20:2 2026-08-21:3 2026-08-22:3 2026-08-23:3 2026-08-24:4 2026-08-25:2 2026-08-26:3 2026-08-27:2 2026-08-28:2 2026-08-29:5 2026-08-30:2 2026-08-31:3 2026-09-18:5 2026-09-19:4 2026-09-20:4 2026-09-21:3 2026-09-22:2 2026-09-23:5 2026-09-24:2 2026-09-25:5 2026-09-27:1 2026-09-28:3 2026-09-30:2 2026-10-01:2 2026-10-02:1 2026-10-03:1 2026-10-04:1 2026-10-05:1 2026-10-08:2 2026-10-10:2 2026-10-17:1 2026-10-20:1 2026-10-22:1 2026-10-24:1 2026-10-27:1 2026-10-29:1 2026-11-01:1",
  [NHL]:
    "2026-09-23:10 2026-09-24:4 2026-09-25:11 2026-09-26:6 2026-09-27:12 2026-09-30:5 2026-10-01:3 2026-10-02:8 2026-10-03:5 2026-10-04:14 2026-10-05:4 2026-10-06:4 2026-10-07:9 2026-10-08:3 2026-10-09:10 2026-10-10:6 2026-10-11:12 2026-10-12:4 2026-10-13:2 2026-10-14:16 2026-10-15:2 2026-10-16:11 2026-10-17:4 2026-10-18:12 2026-10-19:2 2026-10-20:4 2026-10-21:11 2026-10-22:2 2026-10-23:12 2026-10-24:4 2026-10-25:11 2026-10-26:4 2026-10-27:3 2026-10-28:11 2026-10-29:4 2026-10-30:11 2026-10-31:7 2026-11-01:7 2026-11-02:4 2026-11-03:4 2026-11-04:11 2026-11-05:4 2026-11-06:11 2026-11-07:5 2026-11-08:11 2026-11-09:5 2026-11-10:3 2026-11-11:7 2026-11-12:7 2026-11-13:10 2026-11-14:3 2026-11-15:13 2026-11-16:5 2026-11-17:2 2026-11-18:11 2026-11-19:3 2026-11-20:12 2026-11-21:1 2026-11-22:14 2026-11-23:4 2026-11-24:7",
};

// A schedule: ET date -> games that day. Games start 19:00 ET (00:00 UTC the
// next day), the usual evening slot; an earlier slot only makes gaps shorter.
type Schedule = Map<string, number>;
const parse = (s: string): Schedule => new Map(s.split(" ").map((p) => [p.slice(0, 10), Number(p.slice(11))] as [string, number]));
const etKey = (t: number) => new Date(t - 5 * HOUR).toISOString().slice(0, 10);
const kickoff = (date: string) => Date.parse(date + "T00:00:00Z") + DAY; // 19:00 ET that day
const addDays = (date: string, n: number) => new Date(Date.parse(date + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);
function range(from: string, to: string, perDay: number | ((d: string) => number)): [string, number][] {
  const out: [string, number][] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const n = typeof perDay === "number" ? perDay : perDay(d);
    if (n > 0) out.push([d, n]);
  }
  return out;
}
const sched = (...parts: [string, number][][]): Schedule => new Map(parts.flat());

// What the reader would return at `now`: played from game_results (started
// before now, last 14 days), posted from the odds snapshot (after now; today's
// ET slate for daily leagues, a week for football). `postedCut`: the schedule
// feed broke - nothing posted at all.
function observe(sportKey: string, s: Schedule, now: number, opts: { postedCut?: boolean; syncs?: LeagueFeedData["syncs"] } = {}): LeagueFeedData {
  let past7 = 0;
  let past14 = 0;
  let lastGameAt: number | null = null;
  let next7 = 0;
  let nextGameAt: number | null = null;
  const today = etKey(now);
  for (const [date, n] of s) {
    const t = kickoff(date);
    if (t <= now && t > now - 14 * DAY) {
      past14 += n;
      if (t > now - 7 * DAY) past7 += n;
      if (lastGameAt === null || t > lastGameAt) lastGameAt = t;
    }
    const postedHorizon = POSTED_WEEK.has(sportKey) ? t <= now + 7 * DAY : date === today;
    if (!opts.postedCut && t > now && postedHorizon) {
      if (t <= now + 7 * DAY) next7 += n;
      if (nextGameAt === null || t < nextGameAt) nextGameAt = t;
    }
  }
  return {
    sportKey,
    past7,
    past14,
    lastGameAt: lastGameAt === null ? null : new Date(lastGameAt),
    next7,
    nextGameAt: nextGameAt === null ? null : new Date(nextGameAt),
    postedFetchDate: opts.postedCut ? null : today,
    syncs: opts.syncs ?? {},
  };
}

// Status at every 3 hours from `from` through `to` (ET dates), as the ET dates
// on which each status was seen.
function sweep(sportKey: string, s: Schedule, from: string, to: string, opts?: Parameters<typeof observe>[3]) {
  const seen: Record<FeedStatus, string[]> = { in_season: [], off_season: [], check_feed: [] };
  for (let t = Date.parse(from + "T05:00:00Z"); t < Date.parse(addDays(to, 1) + "T05:00:00Z"); t += 3 * HOUR) {
    const st = leagueFeedStatus(observe(sportKey, s, t, opts), new Date(t)).status;
    const d = etKey(t);
    if (seen[st].at(-1) !== d) seen[st].push(d);
  }
  return seen;
}
const statusAt = (sportKey: string, s: Schedule, iso: string, opts?: Parameters<typeof observe>[3]) =>
  leagueFeedStatus(observe(sportKey, s, Date.parse(iso), opts), new Date(Date.parse(iso)));

// ---------------------------------------------------------------------------
// 1. Real 2026 schedules: no warning anywhere except the WNBA's 17-day FIBA
//    World Cup break (documented: an international break is indistinguishable
//    from a dead feed without a calendar).
// ---------------------------------------------------------------------------
for (const { key, label } of FEED_HEALTH_LEAGUES) {
  const s = parse(REAL[key]);
  const dates = [...s.keys()].sort();
  const seen = sweep(key, s, dates[0], "2026-11-24");
  if (key === WNBA) {
    expect(`${label} real 2026: warns only inside the FIBA World Cup break (Sep 1-17)`, seen.check_feed.every((d) => d >= "2026-09-01" && d <= "2026-09-17"), true);
    expect(`${label} real 2026: that warning lasts at most 4 days`, seen.check_feed.length <= 4, true);
  } else {
    expect(`${label} real 2026: never ⚠ Check feed`, seen.check_feed, []);
  }
}

// ---------------------------------------------------------------------------
// 2. In season / Off season, and the season-end transition (MLB 2026, real):
//    the World Series ended Oct 29; the sparse postseason tail never warns,
//    reads In season for 7 days after the last game, then Off season.
// ---------------------------------------------------------------------------
{
  const s = parse(REAL[MLB]);
  expect("MLB mid-season (2026-08-15) is In season", statusAt(MLB, s, "2026-08-15T18:00:00Z").status, "in_season");
  expect("MLB postseason (2026-10-22, 4-day gap before WS game) is In season", statusAt(MLB, s, "2026-10-22T18:00:00Z").status, "in_season");
  const seen = sweep(MLB, s, "2026-10-29", "2026-12-31");
  expect("MLB season end: never warns after the final", seen.check_feed, []);
  expect("MLB season end: In season through 7 days after the final", seen.in_season.at(-1), "2026-11-05");
  expect("MLB season end: then Off season to year end", seen.off_season[0] <= "2026-11-06" && seen.off_season.at(-1) === "2026-12-31", true);
  const wound = statusAt(MLB, s, "2026-11-08T18:00:00Z");
  expect("MLB 10 days after the final: Off season with a 'wound down' note", [wound.status, /wound down/.test(wound.note ?? "")], ["off_season", true]);
  expect("MLB 20 days after the final: plain Off season, no note", [statusAt(MLB, s, "2026-11-18T18:00:00Z").status, statusAt(MLB, s, "2026-11-18T18:00:00Z").note], ["off_season", null]);
}
// Off season by the spec's own definition: nothing either side for 14 days.
expect("no games either side = Off season", leagueFeedStatus(emptyLeague(NBA), new Date()).status, "off_season");

// ---------------------------------------------------------------------------
// 3. Normal gaps that must not warn.
// ---------------------------------------------------------------------------
// NFL weekly rhythm is in REAL (1). The two long football gaps:
// Week 18 -> Wild Card (6 days), and the two-week pre-Super Bowl gap.
{
  const s = sched(
    range("2026-11-26", "2027-01-03", (d) => ({ 4: 1, 0: 13, 1: 1 } as Record<number, number>)[new Date(d + "T12:00:00Z").getUTCDay()] ?? 0),
    [["2027-01-09", 3], ["2027-01-10", 3], ["2027-01-16", 2], ["2027-01-17", 2], ["2027-01-24", 2], ["2027-02-07", 1]]
  );
  const seen = sweep(NFL, s, "2026-12-01", "2027-03-15");
  expect("NFL Week 18 -> Wild Card -> Super Bowl gap -> season end: never warns", seen.check_feed, []);
  expect("NFL pre-Super Bowl gap (2027-01-31) is In season (SB posted a week out)", statusAt(NFL, s, "2027-01-31T18:00:00Z").status, "in_season");
  expect("NFL after the Super Bowl settles to Off season", statusAt(NFL, s, "2027-02-20T18:00:00Z").status, "off_season");
}
// NCAAF: rivalry week -> conference championships -> Army-Navy -> bowls ->
// CFP semis -> 10-day gap -> title game -> end.
{
  const s = sched(
    [["2026-11-28", 70], ["2026-12-04", 6], ["2026-12-05", 8], ["2026-12-12", 1]],
    range("2026-12-19", "2027-01-02", 3),
    [["2027-01-08", 1], ["2027-01-09", 1], ["2027-01-19", 1]]
  );
  const seen = sweep(NCAAF, s, "2026-11-28", "2027-02-28");
  expect("NCAAF conf champs -> Army-Navy -> bowls -> semis -> title gap -> end: never warns", seen.check_feed, []);
}
// NBA All-Star break: Thursday Feb 12 -> Thursday Feb 19 (2026's real shape),
// 7 games a night either side; posted side holds only today's slate.
const nbaAllStar = sched(range("2027-01-20", "2027-02-11", 7), range("2027-02-18", "2027-03-20", 7));
expect("NBA All-Star break (7 days, nothing posted until the day) never warns", sweep(NBA, nbaAllStar, "2027-01-25", "2027-03-01").check_feed, []);
// NHL: Christmas break (Dec 24-26) and a 6-day All-Star break.
{
  const s = sched(range("2026-12-01", "2026-12-23", 7), range("2026-12-27", "2027-01-31", 7), range("2027-02-07", "2027-03-15", 7));
  expect("NHL Christmas + 6-day All-Star break never warn", sweep(NHL, s, "2026-12-05", "2027-03-10").check_feed, []);
}
// NBA season end: Finals tail (games every 2-3 days), then nothing.
{
  const s = sched(range("2027-05-01", "2027-05-31", (d) => (Number(d.slice(8)) % 2 ? 2 : 0)), [["2027-06-03", 1], ["2027-06-05", 1], ["2027-06-08", 1], ["2027-06-10", 1], ["2027-06-13", 1], ["2027-06-16", 1]]);
  const seen = sweep(NBA, s, "2027-06-01", "2027-07-31");
  expect("NBA after the Finals: never warns", seen.check_feed, []);
  expect("NBA after the Finals: Off season by July", statusAt(NBA, s, "2027-07-15T18:00:00Z").status, "off_season");
}

// ---------------------------------------------------------------------------
// 4. A missing schedule does warn: from a real in-season date, every game
//    vanishes (played and posted). Each league must flag within
//    quietPastDays + 1 days.
// ---------------------------------------------------------------------------
const OUTAGE_FROM: Record<string, string> = {
  [NFL]: "2026-10-20",
  [NCAAF]: "2026-10-20",
  [NBA]: "2026-11-12",
  [NCAAB]: "2026-11-18",
  [NHL]: "2026-11-01",
  [MLB]: "2026-08-15",
  [WNBA]: "2026-08-20",
};
for (const { key, label } of FEED_HEALTH_LEAGUES) {
  const cut = OUTAGE_FROM[key];
  const s = new Map([...parse(REAL[key])].filter(([d]) => d < cut));
  const seen = sweep(key, s, cut, addDays(cut, 30), { postedCut: true });
  const first = seen.check_feed[0] ?? null;
  const within = first !== null && first <= addDays(cut, FEED_THRESHOLDS[key].quietPastDays + 1);
  expect(`${label}: schedule vanishing on ${cut} warns within ${FEED_THRESHOLDS[key].quietPastDays + 1} days (first ${first})`, within, true);
}
// The reason names the shape and the missing snapshot.
{
  const s = new Map([...parse(REAL[NBA])].filter(([d]) => d < "2026-11-12"));
  const h = statusAt(NBA, s, "2026-11-22T18:00:00Z", { postedCut: true });
  expect("missing NBA schedule: ⚠ Check feed", h.status, "check_feed");
  expect("missing NBA schedule: reason says so", /none played in 8\+ days and none posted.*no odds snapshot/.test(h.reasons[0] ?? ""), true);
}

// ---------------------------------------------------------------------------
// 5. A stale sync warns while in season - and only then.
// ---------------------------------------------------------------------------
{
  const s = parse(REAL[NBA]);
  const now = Date.parse("2026-11-20T18:00:00Z");
  const sync = (feed: "scores" | "odds", agoH: number | null, errAgoH: number | null = null): FeedSyncRow => ({
    feed,
    sportKey: NBA,
    lastSuccessAt: agoH === null ? null : new Date(now - agoH * HOUR),
    lastErrorAt: errAgoH === null ? null : new Date(now - errAgoH * HOUR),
    lastError: errAgoH === null ? null : "HTTP 500",
  });
  const at = (syncs: LeagueFeedData["syncs"]) => leagueFeedStatus(observe(NBA, s, now, { syncs }), new Date(now));
  expect("fresh syncs: In season", at({ scores: sync("scores", 0.25), odds: sync("odds", 13) }).status, "in_season");
  expect(`scores sync ${SYNC_STALE_HOURS.scores + 1}h old: ⚠ Check feed`, at({ scores: sync("scores", SYNC_STALE_HOURS.scores + 1), odds: sync("odds", 13) }).status, "check_feed");
  expect(`odds sync ${SYNC_STALE_HOURS.odds + 1}h old: ⚠ Check feed`, at({ scores: sync("scores", 0.25), odds: sync("odds", SYNC_STALE_HOURS.odds + 1) }).reasons, [
    `odds sync last succeeded 27h ago (limit ${SYNC_STALE_HOURS.odds}h)`,
  ]);
  expect("never succeeded but errored: ⚠ Check feed", at({ scores: sync("scores", null, 1), odds: sync("odds", 13) }).status, "check_feed");
  expect("no sync rows yet (just deployed): not judged", at({}).status, "in_season");
  // Off season: a gated feed stops syncing; that's not a warning.
  const off = leagueFeedStatus({ ...emptyLeague(NBA), syncs: { scores: sync("scores", 24 * 60), odds: sync("odds", 24 * 60) } }, new Date(now));
  expect("stale syncs in the off season: Off season, no warning", off.status, "off_season");
}

// ---------------------------------------------------------------------------
// 6. Every league is listed once, in order, and the alert line counts them.
// ---------------------------------------------------------------------------
{
  const now = new Date("2026-11-22T18:00:00Z");
  const rows = [observe(NBA, new Map([...parse(REAL[NBA])].filter(([d]) => d < "2026-11-12")), now.getTime(), { postedCut: true })];
  const h = feedHealth(rows, now);
  expect("all seven leagues, in display order", h.map((x) => x.label), ["NFL", "NCAAF", "NBA", "NCAAB", "NHL", "MLB", "WNBA"]);
  expect("alert names the flagged league", feedHealthAlert(h)?.startsWith("NBA: check feed - "), true);
  expect("no alert when nothing is flagged", feedHealthAlert(feedHealth([], now)), null);
  expect("every league has thresholds", FEED_HEALTH_LEAGUES.every((l) => !!FEED_THRESHOLDS[l.key]), true);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
